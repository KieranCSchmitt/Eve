import { z } from 'zod';

export const youtubeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const mediaSecondsSchema = z.number().finite().min(0).max(604_800);
export const youtubeSourceSchema = z.object({
  provider: z.literal('youtube'), videoId: youtubeIdSchema,
  url: z.string().url(), startSeconds: mediaSecondsSchema,
  endSeconds: mediaSecondsSchema.optional(),
}).strict().refine(v => v.url === `https://www.youtube.com/watch?v=${v.videoId}`, 'Expected canonical video URL')
  .refine(v => v.endSeconds === undefined || v.endSeconds > v.startSeconds, 'End must follow start');
export type YouTubeSource = z.infer<typeof youtubeSourceSchema>;
export type SourceResolution = { supported: true; source: YouTubeSource } | { supported: false; reason: string };

function timestamp(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value) <= 604_800 ? Number(value) : null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !value) return null;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds <= 604_800 ? seconds : null;
}

/** URL syntax validation is not a claim that a video is available or embeddable. */
export function resolveYouTubeSource(input: string): SourceResolution {
  const no = (reason: string): SourceResolution => ({ supported: false, reason });
  if (input.length > 4096) return no('The source URL is too long.');
  let url: URL;
  try { url = new URL(input); } catch { return no('Enter a complete HTTPS YouTube video URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return no('Only HTTPS YouTube URLs without credentials or custom ports are supported.');
  const host = url.hostname;
  let videoId: string | undefined;
  if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') {
      if (url.searchParams.getAll('v').length !== 1) return no('The URL must identify one video.');
      videoId = url.searchParams.get('v') ?? undefined;
    } else videoId = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (host === 'youtu.be') videoId = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (host === 'www.youtube-nocookie.com' || host === 'youtube-nocookie.com') videoId = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else return no('This host is not a supported official YouTube host.');
  if (!youtubeIdSchema.safeParse(videoId).success) return no('This URL does not identify a supported video. Playlists, clips, channels, and search pages are not supported.');
  const times = [...url.searchParams.getAll('t'), ...url.searchParams.getAll('start')];
  if (url.hash.startsWith('#t=')) times.push(url.hash.slice(3));
  if (times.length > 1) return no('The URL contains ambiguous start times.');
  const startSeconds = times.length ? timestamp(times[0]) : 0;
  const ends = url.searchParams.getAll('end');
  const endSeconds = ends.length ? timestamp(ends[0]) : undefined;
  if (startSeconds === null || ends.length > 1 || endSeconds === null || (endSeconds !== undefined && endSeconds <= startSeconds)) return no('The video timestamp range is invalid.');
  return { supported: true, source: { provider: 'youtube', videoId: videoId!, url: `https://www.youtube.com/watch?v=${videoId}`, startSeconds, ...(endSeconds === undefined ? {} : { endSeconds }) } };
}

export function sourceMomentUrl(source: YouTubeSource, seconds: number): string {
  const validated = youtubeSourceSchema.parse(source);
  mediaSecondsSchema.parse(seconds);
  return `${validated.url}&t=${Math.floor(seconds)}s`;
}

/** The caller must supply its installed OS application identifier, never a made-up web origin. */
export function applicationReferer(appId: string): string {
  if (!/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/.test(appId) || appId.length > 200) throw new Error('A registered reverse-DNS application ID is required.');
  return `https://${appId.toLowerCase()}/`;
}

export function isOfficialPlayerRequest(input: string): boolean {
  try { const u = new URL(input); return u.protocol === 'https:' && ['www.youtube.com', 'www.youtube-nocookie.com'].includes(u.hostname) && (/^\/embed\//.test(u.pathname) || u.pathname === '/iframe_api'); } catch { return false; }
}
