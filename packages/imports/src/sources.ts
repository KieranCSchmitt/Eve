import { randomUUID } from 'node:crypto';
import { sourceRegistrationSchema, type SourceRegistration } from '../../contracts/src/index';
import { resolveYouTubeSource, sourceMomentUrl } from '../../media/src/youtube';
import { ImportError } from './filesystem';

export interface SourceAttachment {
  taskId: string;
  url: string;
  title: string;
  /** Explicit user-provided material only. This helper does not fetch a page or transcript. */
  excerpt?: string;
  attribution?: string;
  rights?: string;
  attachedAt?: number;
  id?: string;
}

function publicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new ImportError('INVALID_INPUT', 'Enter a complete HTTPS source URL.'); }
  if (input.length > 4096 || url.protocol !== 'https:' || url.username || url.password || /[\u0000-\u0020\u007f]/.test(input)) throw new ImportError('INVALID_INPUT', 'Source URLs must use HTTPS without credentials or whitespace.');
  return url;
}

function registration(input: SourceAttachment, url: string, timing?: { start: number; end?: number }): SourceRegistration {
  const result = sourceRegistrationSchema.safeParse({
    id: input.id ?? randomUUID(), taskId: input.taskId, title: input.title.trim(), url,
    excerpt: input.excerpt ?? '', retrievedAt: input.attachedAt ?? Date.now(),
    ...(timing ? { timestampStart: timing.start, ...(timing.end === undefined ? {} : { timestampEnd: timing.end }) } : {}),
    provenance: { kind: 'web-source', attribution: input.attribution ?? 'Link attached by the user. Availability and contents have not been verified.', rights: input.rights ?? 'Rights have not been verified. No page, video, or transcript was downloaded.', sourceUrl: url },
  });
  if (!result.success) throw new ImportError('INVALID_INPUT', 'The source metadata is invalid.', undefined, { cause: result.error });
  return result.data;
}

/** A stored reference, not an allowlist for host networking or script execution. */
export function normalizeWebSource(input: SourceAttachment): SourceRegistration {
  const url = publicUrl(input.url);
  const youtube = resolveYouTubeSource(url.href);
  if (youtube.supported) return normalizeVideoSource(input);
  return registration(input, url.href);
}

export function normalizeVideoSource(input: SourceAttachment): SourceRegistration {
  publicUrl(input.url);
  const result = resolveYouTubeSource(input.url);
  if (!result.supported) throw new ImportError('UNSUPPORTED_TYPE', result.reason);
  const { source } = result;
  return registration(input, source.startSeconds ? sourceMomentUrl(source, source.startSeconds) : source.url, { start: source.startSeconds, end: source.endSeconds });
}
