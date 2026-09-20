import { describe, expect, it, vi } from 'vitest';
import { articleText, fetchPublicText, isPublicAddress, publicWebUrl, readWebArticle, searchWikipedia, type PublicTransport } from '../../packages/imports/src/web-reader';

describe('public source reading boundaries', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.2.3.4', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1'])('does not connect to special or local address %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '208.80.154.224', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows public unicast %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it.each(['http://example.com', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://localhost', 'https://service.internal', 'https://example.com:8443', 'https://example.com./', 'https://example.com/\npath'])('rejects unsafe source URL %s', url => {
    expect(() => publicWebUrl(url)).toThrow();
  });
  it('validates every redirect before making the next request', async () => {
    const transport = vi.fn<PublicTransport>().mockResolvedValue({ status: 302, location: 'https://169.254.169.254/latest/meta-data', contentType: 'text/html', body: '' });
    await expect(fetchPublicText('https://example.com/article', transport)).rejects.toThrow(/public HTTPS/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('follows only bounded public redirects and records the final URL', async () => {
    const transport = vi.fn<PublicTransport>().mockResolvedValueOnce({ status: 301, location: '/new', contentType: 'text/html', body: '' }).mockResolvedValueOnce({ status: 200, contentType: 'text/html', body: '<p>Text</p>' });
    expect(await fetchPublicText('https://example.com/old#section', transport)).toMatchObject({ url: 'https://example.com/new', body: '<p>Text</p>' });
    const loop = vi.fn<PublicTransport>().mockResolvedValue({ status: 302, location: '/loop', contentType: 'text/html', body: '' });
    await expect(fetchPublicText('https://example.com', loop)).rejects.toThrow(/too many times/);
    expect(loop).toHaveBeenCalledTimes(5);
  });
  it('extracts readable source text and preserves provenance without passing through executable HTML', async () => {
    const body = '<html><head><title>Dreaming &amp; sleep</title><script>alert(1)</script></head><body><nav>menu</nav><main><h1>Dreaming</h1><p>Dogs &amp; other mammals sleep in cycles. This is text supplied by the actual page rather than an invented summary.</p><p>&lt;script&gt;Literal text&lt;/script&gt;</p><form>password</form></main><footer>links</footer></body></html>';
    const transport: PublicTransport = async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body });
    const result = await readWebArticle('https://example.com/article', transport);
    expect(result).toMatchObject({ title: 'Dreaming & sleep', url: 'https://example.com/article', truncated: false });
    expect(result.text).toContain('Dogs & other mammals');
    expect(result.text).toContain('<script>Literal text</script>');
    expect(result.text).not.toMatch(/alert\(1\)|menu|password|links/);
    expect(result.retrievedAt).toBeGreaterThan(0);
  });
  it('reports unreadable and unsupported pages instead of inventing article contents', async () => {
    await expect(readWebArticle('https://example.com', async () => ({ status: 200, contentType: 'text/html', body: '<script>app()</script>' }))).rejects.toThrow(/does not expose enough/);
    await expect(readWebArticle('https://example.com', async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'sign in' }) }))).rejects.toThrow(/does not expose enough/);
    const result = articleText(`<article><p>${'x'.repeat(40_000)}</p></article>`);
    expect(result.text).toHaveLength(32_000); expect(result.truncated).toBe(true);
  });
  it('uses real search response titles to build named provider results, stripping snippet markup', async () => {
    const transport = vi.fn<PublicTransport>().mockResolvedValue({ status: 200, contentType: 'application/json', body: JSON.stringify({ query: { search: [{ title: 'Dog dreams', snippet: 'Dogs <span class="searchmatch">dream</span> during sleep.' }] } }) });
    expect(await searchWikipedia('dogs dreaming', transport)).toEqual([{ title: 'Dog dreams', url: 'https://en.wikipedia.org/wiki/Dog_dreams', excerpt: 'Dogs dream during sleep.', provider: 'Wikipedia' }]);
    expect(transport.mock.calls[0]![0].hostname).toBe('en.wikipedia.org');
    expect(transport.mock.calls[0]![0].searchParams.get('srsearch')).toBe('dogs dreaming');
  });
  it('does not present failed provider responses as search results', async () => {
    await expect(searchWikipedia('dogs', async () => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ratelimited' } }) }))).rejects.toThrow(/unavailable/);
  });
});
