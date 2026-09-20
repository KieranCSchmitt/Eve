import { describe, expect, it } from 'vitest';
import { applicationReferer, resolveYouTubeSource, sourceMomentUrl, youtubeSourceSchema } from '../../packages/media/src/youtube';
import { CHROME_ANIMATION_LESSON, ORBIT_LESSON_NOTES, authoredLessonNoteSchema, normalizeSourceRecord, registerAuthoredNote, selectLessonNotes } from '../../packages/media/src/sources';
import { generatePlayerDocument } from '../../packages/media/src/document';
import { mediaCommandSchema, toCoreMediaContext } from '../../packages/media/src/protocol';

const videoId = 'lVLzkleL_CE';
const source = { provider: 'youtube' as const, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, startSeconds: 0 };
describe('verified YouTube source handling', () => {
  it('supports official video URL forms without retaining tracking parameters', () => {
    for (const url of [`https://www.youtube.com/watch?v=${videoId}&si=tracking`, `https://youtu.be/${videoId}`, `https://m.youtube.com/watch?v=${videoId}`, `https://www.youtube.com/shorts/${videoId}`, `https://www.youtube.com/live/${videoId}`, `https://www.youtube-nocookie.com/embed/${videoId}`]) expect(resolveYouTubeSource(url)).toEqual({ supported: true, source });
    expect(resolveYouTubeSource(`https://youtu.be/${videoId}?t=1m12s&end=100`)).toEqual({ supported: true, source: { ...source, startSeconds: 72, endSeconds: 100 } });
    expect(sourceMomentUrl(source, 12.8)).toBe(`${source.url}&t=12s`);
  });
  it('rejects host spoofing, unsupported IDs and ambiguous timestamps', () => {
    for (const url of [`http://youtube.com/watch?v=${videoId}`, `https://youtube.com.evil.test/watch?v=${videoId}`, `https://youtube.com@evil.test/watch?v=${videoId}`, `https://user:pass@youtube.com/watch?v=${videoId}`, `https://youtube.com:123/watch?v=${videoId}`, `https://youtube.com/playlist?list=anything`, `https://youtube.com/watch?v=short`, `https://youtube.com/watch?v=${videoId}&v=${videoId}`, `https://youtu.be/${videoId}?start=1&t=2`, `https://youtu.be/${videoId}?t=-1`, `https://youtu.be/${videoId}?t=30&end=10`, `https://youtu.be/${videoId}?t=Infinity`]) expect(resolveYouTubeSource(url).supported, url).toBe(false);
    expect(youtubeSourceSchema.safeParse({ ...source, url: 'https://other.test' }).success).toBe(false);
    expect(applicationReferer('org.eve.Shell')).toBe('https://org.eve.shell/');
    expect(() => applicationReferer('https://fake.test')).toThrow();
  });
  it('keeps authored notes separate from transcript and verified timing claims', () => {
    expect(CHROME_ANIMATION_LESSON.transcriptAvailable).toBe(false);
    const note = registerAuthoredNote({ note: ORBIT_LESSON_NOTES[0], source, taskId: 'orbit', lessonTitle: CHROME_ANIMATION_LESSON.title });
    const normalized = normalizeSourceRecord(note, 123);
    expect(normalized.provenance.kind).toBe('timestamped-notes');
    expect(normalized.provenance.attribution).toContain('not a verified transcript alignment');
    expect(normalized.url).toBe(`${source.url}&t=0s`);
    expect(normalized.createdAt).toBe(123);
    expect(selectLessonNotes(ORBIT_LESSON_NOTES, 40)).toEqual({ aligned: [], general: ORBIT_LESSON_NOTES });
    expect(authoredLessonNoteSchema.safeParse({ ...ORBIT_LESSON_NOTES[0], alignment: 'verified-segment' }).success).toBe(false);
  });
});

describe('isolated player document', () => {
  it('escapes source text, retains official controls, and does not autoplay', () => {
    const result = generatePlayerDocument({ source, scope: { taskId: '</script><script>alert(1)</script>', taskEpoch: 1, generation: 2, sourceId: 'lesson' }, title: '<img src=x onerror=alert(1)>', appId: 'org.eve.Shell', url: `http://127.0.0.1:1234/${'a'.repeat(48)}/` });
    expect(result.html).not.toContain('<img src=x');
    expect(result.html).not.toContain('</script><script>alert');
    expect(result.html).toContain('autoplay=0');
    expect(result.html).toContain('controls=1');
    expect(result.html).toContain('https://www.youtube.com/iframe_api');
    expect(result.contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(result.contentSecurityPolicy).not.toContain('unsafe-eval');
    expect(result.html).not.toContain('ipcRenderer');
  });
  it('requires explicit visible play and does not call buffering a paused snapshot', () => {
    const envelope = { version: 1, requestId: 'request', scope: { taskId: 'orbit', taskEpoch: 1, generation: 0, sourceId: 'lesson' } };
    expect(mediaCommandSchema.safeParse({ ...envelope, type: 'play' }).success).toBe(false);
    expect(mediaCommandSchema.safeParse({ ...envelope, type: 'play', intent: 'explicit-user', visible: true, execute: 'evil' }).success).toBe(false);
    expect(toCoreMediaContext({ videoId, currentTime: 14, duration: 90, playbackState: 'buffering' })).toBeNull();
    expect(toCoreMediaContext({ videoId, currentTime: 14, duration: 90, playbackState: 'paused' })).toEqual({ videoId, currentTime: 14, state: 'paused' });
  });
});
