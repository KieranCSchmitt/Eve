import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export const WEB_READ_LIMITS = Object.freeze({ bytes: 2_000_000, text: 32_000, timeoutMs: 12_000, redirects: 4 });
export interface ArticleReading {
  url: string;
  title: string;
  text: string;
  retrievedAt: number;
  truncated: boolean;
}
export interface SourceSearchResult { title: string; url: string; excerpt: string; provider: 'Wikipedia' }
export interface PublicResponse { status: number; location?: string; contentType: string; body: string }
export type PublicTransport = (url: URL, signal: AbortSignal) => Promise<PublicResponse>;

/** Refuse private, link-local, multicast, reserved and transition addresses before any socket opens. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const [first, second] = address.toLowerCase().split(':').map(part => parseInt(part || '0', 16));
  // Only globally routed unicast. Exclude special-purpose 2001::/23, documentation and 6to4.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    !(first === 0x3fff && second < 0x1000);
}

export function publicWebUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Enter a complete HTTPS article link.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (input.length > 4096 || /[\u0000-\u0020\u007f]/.test(input) || url.protocol !== 'https:' || url.username || url.password ||
    (url.port && url.port !== '443') || hostname.endsWith('.') || !hostname.includes('.') && !isIP(hostname) ||
    /(^|\.)(localhost|local|internal|home|lan|test|invalid|onion)$/.test(hostname) || (isIP(hostname) && !isPublicAddress(hostname)))
    throw new Error('Eve can read public HTTPS articles only.');
  url.hash = '';
  return url;
}

/** Pin the verified lookup result to this request: a second DNS lookup cannot rebind to the local network. */
export const requestPublicPage: PublicTransport = async (url, signal) => {
  url = publicWebUrl(url.href);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error('The source took too long to respond.'));
      else signal.addEventListener('abort', () => reject(new Error('The source took too long to respond.')), { once: true });
    }),
  ]);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('This source does not resolve to a public website.');
  signal.throwIfAborted();
  const pinned = addresses.find(item => item.family === 4) ?? addresses[0]!;
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    callback(null, options.all ? [pinned] : pinned.address, pinned.family);
  };
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, lookup: pinnedLookup, family: pinned.family, signal,
      headers: { Accept: 'text/html, text/plain, application/json;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'EveDesktop/0.1 (user-requested source reader)' },
    }, response => {
      const status = response.statusCode ?? 0;
      const contentType = response.headers['content-type'] ?? '';
      if (status >= 300 && status < 400) {
        response.destroy(); resolve({ status, location: response.headers.location, contentType, body: '' }); return;
      }
      if (status !== 200) { response.destroy(); reject(new Error(`The source could not be read (HTTP ${status}). Open the original source to continue.`)); return; }
      if (!/^(?:text\/(?:html|plain)|application\/json)(?:;|$)/i.test(contentType) ||
        (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); reject(new Error('This source is not a readable text page. Open the original source to continue.')); return;
      }
      if (Number(response.headers['content-length'] ?? 0) > WEB_READ_LIMITS.bytes) {
        response.destroy(); reject(new Error('This page is too large to read here. Open the original source to continue.')); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > WEB_READ_LIMITS.bytes) { response.destroy(new Error('This page is too large to read here.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
};

export async function fetchPublicText(input: string, transport: PublicTransport = requestPublicPage): Promise<{ url: string; contentType: string; body: string }> {
  let url = publicWebUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_READ_LIMITS.timeoutMs);
  try {
    for (let hop = 0; hop <= WEB_READ_LIMITS.redirects; hop++) {
      const response = await transport(url, controller.signal);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location || hop === WEB_READ_LIMITS.redirects) throw new Error('This source redirected too many times. Open the original source to continue.');
        url = publicWebUrl(new URL(response.location, url).href); continue;
      }
      if (response.status !== 200) throw new Error(`The source could not be read (HTTP ${response.status}).`);
      return { url: url.href, contentType: response.contentType, body: response.body };
    }
    throw new Error('This source could not be read.');
  } finally { clearTimeout(timeout); }
}

function entities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

/** Plain text only. This output must never be inserted as HTML or treated as instructions. */
export function articleText(html: string): { title: string; text: string; truncated: boolean } {
  const title = entities(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, '') ?? '').trim().slice(0, 240);
  let readable = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template|svg|nav|footer|header|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  readable = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(readable)?.[1] ?? /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(readable)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(readable)?.[1] ?? readable;
  const text = entities(readable.replace(/<(?:br|hr)\b[^>]*>/gi, '\n').replace(/<\/(?:p|div|h[1-6]|li|blockquote|section|tr)\s*>/gi, '\n\n').replace(/<[^>]*>/g, ''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: text.slice(0, WEB_READ_LIMITS.text), truncated: text.length > WEB_READ_LIMITS.text };
}

export async function readWebArticle(input: string, transport: PublicTransport = requestPublicPage): Promise<ArticleReading> {
  const page = await fetchPublicText(input, transport);
  const extracted = /^text\/plain(?:;|$)/i.test(page.contentType)
    ? { title: new URL(page.url).hostname, text: page.body.slice(0, WEB_READ_LIMITS.text), truncated: page.body.length > WEB_READ_LIMITS.text }
    : /^text\/html(?:;|$)/i.test(page.contentType) ? articleText(page.body) : null;
  if (!extracted || extracted.text.length < 80) throw new Error('This page does not expose enough readable text. It may need sign-in or scripts. Open the original source to continue.');
  return { ...extracted, title: extracted.title || new URL(page.url).hostname, url: page.url, retrievedAt: Date.now() };
}

/** A real, named discovery provider; returned URLs are built from IDs/titles actually returned by its API. */
export async function searchWikipedia(query: string, transport: PublicTransport = requestPublicPage): Promise<SourceSearchResult[]> {
  if (!query.trim() || query.length > 300) throw new Error('Search with a phrase of up to 300 characters.');
  const endpoint = new URL('https://en.wikipedia.org/w/api.php');
  endpoint.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: query.trim(), srlimit: '6', format: 'json', utf8: '1' }).toString();
  const response = await fetchPublicText(endpoint.href, transport);
  if (new URL(response.url).hostname !== 'en.wikipedia.org') throw new Error('The article search provider redirected unexpectedly.');
  const body: unknown = JSON.parse(response.body);
  if (!body || typeof body !== 'object' || !('query' in body)) throw new Error('Article search is unavailable right now. You can still paste a source link.');
  const results = (body as { query?: { search?: unknown } }).query?.search;
  if (!Array.isArray(results)) throw new Error('Article search is unavailable right now.');
  return results.slice(0, 6).flatMap(item => {
    if (!item || typeof item.title !== 'string' || item.title.length > 240 || typeof item.snippet !== 'string') return [];
    return [{ title: item.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replaceAll(' ', '_'))}`, excerpt: articleText(item.snippet).text.slice(0, 800), provider: 'Wikipedia' as const }];
  });
}
