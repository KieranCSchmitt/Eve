import { z } from 'zod';
import { sourceRegistrationSchema, type SourceRecord, type SourceRegistration } from '../../contracts/src/index';
import { mediaSecondsSchema, resolveYouTubeSource, sourceMomentUrl, type YouTubeSource } from './youtube';

export const authoredLessonNoteSchema = z.object({
  id: z.string().min(1).max(128), author: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(16_000), startSeconds: mediaSecondsSchema,
  endSeconds: mediaSecondsSchema.optional(),
  alignment: z.enum(['author-bookmark', 'verified-segment']),
  rights: z.string().trim().min(1).max(700), authoredAt: z.number().int().nonnegative(),
  /** A verified segment needs human observation or an authorized published timing reference. */
  alignmentEvidence: z.string().trim().min(1).max(1000).optional(),
}).strict().refine(n => n.endSeconds === undefined || n.endSeconds >= n.startSeconds, 'Invalid note range')
  .refine(n => n.alignment !== 'verified-segment' || !!n.alignmentEvidence, 'Verified segment needs evidence');
export type AuthoredLessonNote = z.infer<typeof authoredLessonNoteSchema>;

/** Normalize without promoting an authored explanation to a transcript or inventing retrieval time. */
export function normalizeSourceRecord(input: SourceRegistration, createdAt: number): SourceRecord {
  z.number().int().nonnegative().parse(createdAt);
  const source = sourceRegistrationSchema.parse(input);
  if (source.url) {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Source URLs must use HTTPS without credentials.');
    const youtube = resolveYouTubeSource(source.url);
    if (youtube.supported) source.url = source.timestampStart === undefined ? youtube.source.url : sourceMomentUrl(youtube.source, source.timestampStart);
    else source.url = url.href;
  }
  return { ...source, createdAt };
}

export function registerAuthoredNote(options: { note: AuthoredLessonNote; source: YouTubeSource; taskId: string; lessonTitle: string }): SourceRegistration {
  const note = authoredLessonNoteSchema.parse(options.note);
  return sourceRegistrationSchema.parse({
    id: note.id, taskId: options.taskId, title: `${options.lessonTitle} · Authored notes`.slice(0, 240),
    url: sourceMomentUrl(options.source, note.startSeconds), excerpt: note.text,
    retrievedAt: note.authoredAt, timestampStart: note.startSeconds, timestampEnd: note.endSeconds,
    provenance: { kind: 'timestamped-notes', attribution: `Original notes by ${note.author}. ${note.alignment === 'author-bookmark' ? 'Timestamp is an author bookmark, not a verified transcript alignment.' : `Segment alignment: ${note.alignmentEvidence}`}`,
      rights: note.rights, sourceUrl: options.source.url },
  });
}

export function selectLessonNotes(notes: readonly AuthoredLessonNote[], currentTime: number): { aligned: AuthoredLessonNote[]; general: AuthoredLessonNote[] } {
  mediaSecondsSchema.parse(currentTime);
  const parsed = notes.map(note => authoredLessonNoteSchema.parse(note));
  return {
    aligned: parsed.filter(n => n.alignment === 'verified-segment' && currentTime >= n.startSeconds && currentTime <= (n.endSeconds ?? n.startSeconds)),
    general: parsed.filter(n => n.alignment === 'author-bookmark'),
  };
}

/** Deliberately separate verified publisher metadata from our own teaching material. */
export const CHROME_ANIMATION_LESSON = Object.freeze({
  title: 'How to inspect animations #DevToolsTips', publisher: 'Chrome for Developers',
  url: 'https://www.youtube.com/watch?v=lVLzkleL_CE',
  discoveryUrl: 'https://developer.chrome.com/blog/devtools-tips-12',
  relatedReadingUrl: 'https://web.dev/articles/the-basics-of-easing',
  verifiedAt: '2026-09-19',
  evidence: 'The official Chrome article embeds lVLzkleL_CE; YouTube oEmbed identifies the title and Chrome for Developers publisher.',
  playbackQualified: false,
  transcriptAvailable: false,
});

/** Bookmark zero is intentional: no claim is made about an unobserved segment of the video. */
export const ORBIT_LESSON_NOTES: readonly AuthoredLessonNote[] = Object.freeze([{
  id: 'orbit-easing-authored-notes', author: 'Eve project', startSeconds: 0, alignment: 'author-bookmark',
  authoredAt: Date.UTC(2026, 8, 19), rights: 'Original explanation authored for Eve; may be used in this project. Not a transcript of the linked video.',
  text: 'Before watching: easing changes the distribution of motion over a transition. Duration controls how long that transition takes. In Orbit, these settings affect the decorative card transition; the focus timer keeps its own monotonic clock. Try changing the curve while keeping duration fixed, then compare a short and a long duration with the same curve. These are authored study notes, not words or a timestamped claim from the video.',
}]);
