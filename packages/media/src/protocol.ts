import { z } from 'zod';
import { mediaSecondsSchema, youtubeIdSchema } from './youtube';

export const MEDIA_PROTOCOL_VERSION = 1 as const;
const id = z.string().min(1).max(128);
export const mediaScopeSchema = z.object({
  taskId: id, taskEpoch: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), sourceId: id,
}).strict();
export type MediaScope = z.infer<typeof mediaScopeSchema>;
export const playbackStateSchema = z.enum(['unstarted', 'cued', 'playing', 'paused', 'buffering', 'ended']);
export const playerSnapshotSchema = z.object({
  videoId: youtubeIdSchema, currentTime: mediaSecondsSchema, duration: mediaSecondsSchema,
  playbackState: playbackStateSchema,
}).strict();
export type PlayerSnapshot = z.infer<typeof playerSnapshotSchema>;
const envelope = { version: z.literal(MEDIA_PROTOCOL_VERSION), scope: mediaScopeSchema, requestId: id };
export const mediaCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('pause') }).strict(),
  z.object({ ...envelope, type: z.literal('seek'), seconds: mediaSecondsSchema }).strict(),
  z.object({ ...envelope, type: z.literal('capture'), pause: z.boolean() }).strict(),
  z.object({ ...envelope, type: z.literal('play'), intent: z.literal('explicit-user'), visible: z.literal(true) }).strict(),
]);
export type MediaCommand = z.infer<typeof mediaCommandSchema>;
export type MediaCommandInput = MediaCommand extends infer C ? C extends MediaCommand ? Omit<C, 'version' | 'scope' | 'requestId'> : never : never;
export const mediaCancellationSchema = z.object(envelope).strict();
export const unavailableReasonSchema = z.enum(['network', 'invalid-video', 'playback-error', 'removed-or-private', 'embedding-disabled', 'missing-client-identity', 'autoplay-blocked', 'bridge-disconnected', 'source-changed', 'unknown']);
export type UnavailableReason = z.infer<typeof unavailableReasonSchema>;
export const mediaEventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), scope: mediaScopeSchema, type: z.literal('ready'), snapshot: playerSnapshotSchema }).strict(),
  z.object({ version: z.literal(1), scope: mediaScopeSchema, type: z.literal('snapshot'), snapshot: playerSnapshotSchema }).strict(),
  z.object({ ...envelope, type: z.literal('command-result'), ok: z.literal(true), snapshot: playerSnapshotSchema }).strict(),
  z.object({ ...envelope, type: z.literal('command-error'), message: z.string().min(1).max(500) }).strict(),
  z.object({ version: z.literal(1), scope: mediaScopeSchema, type: z.literal('unavailable'), reason: unavailableReasonSchema, code: z.number().int().optional() }).strict(),
]);
export type MediaEvent = z.infer<typeof mediaEventSchema>;
export const mediaCheckpointSchema = z.object({
  version: z.literal(1), scope: mediaScopeSchema, snapshot: playerSnapshotSchema, capturedAt: z.number().int().nonnegative(),
}).strict();
export type MediaCheckpoint = z.infer<typeof mediaCheckpointSchema>;

export function sameMediaScope(a: MediaScope, b: MediaScope): boolean {
  return a.taskId === b.taskId && a.taskEpoch === b.taskEpoch && a.generation === b.generation && a.sourceId === b.sourceId;
}

/** Buffering/loading is not fabricated as paused. Cued is a real nonplaying, seekable position. */
export function toCoreMediaContext(snapshot: PlayerSnapshot): { videoId: string; currentTime: number; state: 'playing' | 'paused' | 'ended' } | null {
  const value = playerSnapshotSchema.parse(snapshot);
  if (value.playbackState === 'unstarted' || value.playbackState === 'buffering') return null;
  return { videoId: value.videoId, currentTime: value.currentTime, state: value.playbackState === 'cued' ? 'paused' : value.playbackState };
}
