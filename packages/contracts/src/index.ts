import { z } from 'zod';
export * from './workspace-edits';
export * from './canvas';
import { canvasDocumentSchema, type CanvasRecord } from './canvas';

export const CONTRACT_VERSION = 1 as const;
export const idSchema = z.string().min(1).max(128);
export const revisionSchema = z.number().int().nonnegative();
const timeSchema = z.number().int().nonnegative();

export const easingSchema = z.tuple([
  z.number().min(0).max(1), z.number().min(-2).max(3),
  z.number().min(0).max(1), z.number().min(-2).max(3),
]);
export const orbitParametersSchema = z.object({
  theme: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  durationMinutes: z.number().int().min(1).max(180),
  transitionMs: z.number().int().min(0).max(3000),
  easing: easingSchema,
}).strict();
export type OrbitParameters = z.infer<typeof orbitParametersSchema>;
export type OrbitParameterName = keyof OrbitParameters;

export const mediaContextSchema = z.object({
  videoId: z.string().min(1).max(128),
  currentTime: z.number().nonnegative().finite(),
  state: z.enum(['playing', 'paused', 'ended']),
}).strict();
export const contextSnapshotSchema = z.object({
  id: idSchema, taskId: idSchema, taskEpoch: revisionSchema, createdAt: timeSchema,
  selection: z.object({ artifactId: idSchema, revision: revisionSchema, text: z.string().max(32_000).optional() }).strict().optional(),
  media: mediaContextSchema.optional(),
}).strict();
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;
export const intentRequestSchema = z.object({
  id: idSchema, text: z.string().trim().min(1).max(16_000),
  inputModality: z.enum(['typed', 'voice']), taskId: idSchema, taskEpoch: revisionSchema,
  contextSnapshotId: idSchema, utteranceId: idSchema.optional(), generation: revisionSchema,
}).strict();
export type IntentRequest = z.infer<typeof intentRequestSchema>;

export const activitySchema = z.enum(['notes', 'code', 'preview', 'video', 'easing', 'canvas']);
export type Activity = z.infer<typeof activitySchema>;
export const noteViewCheckpointSchema = z.object({
  version: z.literal(1), noteId: idSchema, noteRevision: revisionSchema,
  selection: z.object({ anchor: revisionSchema.max(2_000_000), head: revisionSchema.max(2_000_000) }).strict(),
  scrollTop: z.number().finite().nonnegative().max(10_000_000),
}).strict();
export type NoteViewCheckpoint = z.infer<typeof noteViewCheckpointSchema>;
export const checkpointSchema = z.object({
  layout: z.enum(['work', 'inspect', 'learn', 'recall']),
  selectedActivity: activitySchema,
  selectedFile: z.string().max(4096).optional(),
  selection: z.object({ anchorLine: revisionSchema, anchorColumn: revisionSchema, activeLine: revisionSchema, activeColumn: revisionSchema }).strict().optional(),
  topLine: revisionSchema.optional(),
  media: mediaContextSchema.optional(),
  noteView: noteViewCheckpointSchema.optional(),
  returnAnchors: z.array(activitySchema).max(20).default([]),
}).strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;

export interface NoteRecord { id: string; body: string; revision: number; updatedAt: number }
export interface ParameterRecord { values: OrbitParameters; revision: number; updatedAt: number }
export const taskPolicySchema = z.object({ processing: z.enum(['local-only', 'hybrid']), assistancePaused: z.boolean() }).strict();
export type TaskPolicy = z.infer<typeof taskPolicySchema>;
export const projectRootIdentitySchema = z.object({
  device: z.string().regex(/^(0|[1-9]\d{0,19})$/), inode: z.string().regex(/^(0|[1-9]\d{0,19})$/),
}).strict().refine(value => { try { return BigInt(value.device) <= 18446744073709551615n && BigInt(value.inode) <= 18446744073709551615n; } catch { return false; } }, 'Filesystem identity exceeds uint64.');
const projectRelativePathSchema = z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/[\u0000-\u001f\u007f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..'), 'Use a safe relative project path.');
export const projectPreviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('static'), entry: projectRelativePathSchema }).strict(),
  z.object({ kind: z.literal('loopback'), url: z.string().max(4096).refine(value => {
    try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.hash && !/[\u0000-\u0020\u007f\\]/.test(value) && /^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(value); } catch { return false; }
  }, 'Use an explicit HTTP loopback URL without credentials or a fragment.') }).strict(),
]);
export const projectRegistrationSchema = z.object({
  id: idSchema, canonicalRoot: z.string().min(1).max(4096), rootIdentity: projectRootIdentitySchema,
  kind: z.enum(['managed', 'external']), adapter: z.enum(['orbit', 'generic']), preview: projectPreviewSchema,
}).strict();
const projectBase = { id: idSchema, canonicalRoot: z.string().min(1).max(4096), adapter: z.enum(['orbit', 'generic']), preview: projectPreviewSchema, revision: revisionSchema, createdAt: timeSchema, updatedAt: timeSchema };
export const projectRecordSchema = z.discriminatedUnion('verification', [
  z.object({ ...projectBase, verification: z.literal('verified'), rootIdentity: projectRootIdentitySchema, kind: z.enum(['managed', 'external']) }).strict(),
  z.object({ ...projectBase, verification: z.literal('legacy-unverified'), rootIdentity: z.null(), kind: z.enum(['managed', 'external']).nullable() }).strict(),
]);
export type ProjectRootIdentity = z.infer<typeof projectRootIdentitySchema>;
export type ProjectPreview = z.infer<typeof projectPreviewSchema>;
export type ProjectRegistration = z.infer<typeof projectRegistrationSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
const projectAdmission = { requestId: idSchema, taskId: idSchema, expectedEpoch: revisionSchema, expectedTaskRevision: revisionSchema };
export const registerProjectSchema = z.object({ ...projectAdmission, project: projectRegistrationSchema, parameters: orbitParametersSchema.optional() }).strict().refine(value => (value.project.adapter === 'orbit') === (value.parameters !== undefined), 'Orbit needs host-validated parameters; generic projects cannot expose Orbit controls.');
export const verifyProjectSchema = z.object({ ...projectAdmission, projectId: idSchema, expectedProjectRevision: revisionSchema, rootIdentity: projectRootIdentitySchema, kind: z.enum(['managed', 'external']), adapter: z.enum(['orbit', 'generic']), preview: projectPreviewSchema, parameters: orbitParametersSchema.optional() }).strict().refine(value => value.adapter === 'orbit' || value.parameters === undefined, 'Generic projects cannot expose Orbit controls.');
export type RegisterProjectInput = z.infer<typeof registerProjectSchema>;
export type VerifyProjectInput = z.infer<typeof verifyProjectSchema>;
export type ProjectRegistrationResult = { ok: true; project: ProjectRecord; snapshot: CoreSnapshot; idempotent: boolean } | CoreFailure;
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  kind: 'project' | 'note';
  projectPath: string | null;
  /** Core always emits this; optional for older renderer/fixture compatibility. Execution trust belongs to the host. */
  project?: ProjectRecord | null;
  revision: number;
  epoch: number;
  createdAt: number;
  updatedAt: number;
  note: NoteRecord;
  canvas?: CanvasRecord | null;
  parameters: ParameterRecord | null;
  checkpoint: (Checkpoint & { revision: number; updatedAt: number }) | null;
  policy: TaskPolicy & { revision: number };
}

const envelope = { requestId: idSchema, jobToken: z.object({ id: idSchema, generation: revisionSchema }).strict().optional() };
const scoped = { ...envelope, taskId: idSchema, expectedEpoch: revisionSchema };
export const coreCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('CreateTask'), title: z.string().trim().min(1).max(120), description: z.string().max(1000).default(''), kind: z.enum(['note', 'project']).default('note') }).strict(),
  z.object({ ...scoped, type: z.literal('RenameTask'), expectedRevision: revisionSchema, title: z.string().trim().min(1).max(120) }).strict(),
  z.object({ ...envelope, type: z.literal('RecallTask'), taskId: idSchema }).strict(),
  z.object({ ...scoped, type: z.literal('ShowHome') }).strict(),
  z.object({ ...scoped, type: z.literal('UpdateCanvas'), expectedRevision: revisionSchema, document: canvasDocumentSchema }).strict(),
  z.object({ ...scoped, type: z.literal('UpdateNote'), expectedRevision: revisionSchema, body: z.string().max(1_000_000) }).strict(),
  z.object({ ...scoped, type: z.literal('SaveCheckpoint'), expectedRevision: revisionSchema, checkpoint: checkpointSchema }).strict(),
  z.object({ ...scoped, type: z.literal('SetParameter'), expectedRevision: revisionSchema, name: z.enum(['theme', 'durationMinutes', 'transitionMs', 'easing']), value: z.union([z.string(), z.number(), easingSchema]) }).strict(),
  z.object({ ...scoped, type: z.literal('Undo'), operationId: idSchema.optional() }).strict(),
  z.object({ ...scoped, type: z.literal('SetTaskPolicy'), expectedRevision: revisionSchema, policy: taskPolicySchema }).strict(),
]);
export type CoreCommand = z.infer<typeof coreCommandSchema>;
export type CoreCommandInput = z.input<typeof coreCommandSchema>;

export const capabilitySchema = z.enum(['tasks:create', 'tasks:rename', 'tasks:recall', 'notes:write', 'canvas:write', 'checkpoints:write', 'parameters:write', 'parameters:observe', 'history:undo', 'policy:write', 'assets:attach', 'sources:attach', 'jobs:manage', 'projects:register', 'workspace:apply']);
export type Capability = z.infer<typeof capabilitySchema>;
export const ALL_CAPABILITIES: readonly Capability[] = capabilitySchema.options;
/** Created by the host after authenticating its caller, never accepted from a renderer/model payload. */
export const authenticatedContextSchema = z.object({
  actorId: idSchema, origin: z.enum(['trusted-ui', 'workbench', 'model']),
  capabilities: z.array(capabilitySchema).max(20),
  taskIds: z.array(idSchema).max(100).optional(),
}).strict();
export type AuthenticatedContext = z.infer<typeof authenticatedContextSchema>;

export interface OperationRecord {
  id: string;
  requestId: string;
  taskId: string;
  type: CoreCommand['type'] | 'ApplyWorkspaceEdit' | 'UndoWorkspaceEdit';
  label: string;
  createdAt: number;
  undoable: boolean;
  undone: boolean;
}
export interface CoreSnapshot {
  version: typeof CONTRACT_VERSION;
  activeTaskId: string | null;
  tasks: TaskRecord[];
  recentActions: OperationRecord[];
}
export interface SearchResult { taskId: string; title: string; excerpt: string; score: number }
export type CoreErrorCode = 'INVALID_COMMAND' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'STALE_EPOCH' | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'NOT_UNDOABLE' | 'STORAGE_ERROR' | 'EXTERNAL_EDIT_REQUIRED' | 'EDIT_PENDING' | 'EDIT_CONFLICT' | 'INVALID_RECEIPT' | 'JOB_CANCELLED' | 'EDITOR_RECOVERY_REQUIRED' | 'PROJECT_ALREADY_ATTACHED' | 'PROJECT_ROOT_CONFLICT' | 'PROJECT_IDENTITY_CONFLICT';
export interface CoreFailure { ok: false; snapshot: CoreSnapshot; error: { code: CoreErrorCode; message: string; details?: Record<string, unknown> } }
export type DispatchResult =
  | { ok: true; snapshot: CoreSnapshot; operation: OperationRecord; idempotent: boolean }
  | CoreFailure;

export interface ProjectEditPlan {
  taskId: string; projectPath: string; before: OrbitParameters; after: OrbitParameters; undoOf?: string;
}
export type PreflightResult = { ok: true; command: CoreCommand; duplicate?: Extract<DispatchResult, { ok: true }>; projectEdit?: ProjectEditPlan; pendingEdit?: ProjectEditRecord } | CoreFailure;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const projectEditPreparationSchema = z.object({
  relativePath: z.literal('eve.project.json'),
  beforeHash: hashSchema, afterHash: hashSchema,
  beforeText: z.string().max(64_000), afterText: z.string().max(64_000),
  location: z.enum(['file', 'buffer', 'unknown']).default('unknown'),
  documentVersion: revisionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.location === 'buffer' && value.documentVersion === undefined) context.addIssue({ code: 'custom', path: ['documentVersion'], message: 'A buffer preparation needs its observed document version.' });
});
/** Location is optional for older callers; omission has conservative unknown-origin semantics. */
export type ProjectEditPreparation = z.input<typeof projectEditPreparationSchema>;
export const projectEditReceiptSchema = z.object({
  operationId: idSchema, location: z.enum(['file', 'buffer']), file: z.string().min(1).max(4096),
  beforeHash: hashSchema, afterHash: hashSchema, beforeText: z.string().max(64_000), afterText: z.string().max(64_000),
  documentVersion: revisionSchema.optional(),
}).strict();
export type ProjectEditReceipt = z.infer<typeof projectEditReceiptSchema>;
export const projectEditObservationSchema = z.object({ location: z.enum(['file', 'buffer']), observedHash: hashSchema, documentVersion: revisionSchema.optional() }).strict();
export type ProjectEditObservation = z.infer<typeof projectEditObservationSchema>;
export interface ProjectEditRecord extends ProjectEditPreparation {
  location: 'file' | 'buffer' | 'unknown';
  id: string; requestId: string; taskId: string; projectPath: string;
  command: CoreCommand; plan: ProjectEditPlan;
  status: 'prepared' | 'receipt-recorded' | 'finalized' | 'conflict' | 'aborted';
  receipt: ProjectEditReceipt | null;
  createdAt: number; updatedAt: number;
}
export type PrepareProjectEditResult = { ok: true; edit: ProjectEditRecord | null; resumed: boolean; duplicate?: Extract<DispatchResult, { ok: true }> } | CoreFailure;
export type ProjectEditResult = { ok: true; edit: ProjectEditRecord } | CoreFailure;
export type ReconcileProjectEditResult = { ok: true; edit: ProjectEditRecord; action: 'retry' | 'finalize' | 'conflict' | 'complete' | 'aborted' } | CoreFailure;

export const provenanceSchema = z.object({
  kind: z.enum(['user-import', 'user-authored', 'web-source', 'licensed-transcript', 'timestamped-notes']),
  attribution: z.string().max(1000), rights: z.string().max(1000),
  sourceUrl: z.string().url().max(4096).optional(),
}).strict();
export const assetRegistrationSchema = z.object({
  id: idSchema, taskId: idSchema, originalPath: z.string().max(4096), managedPath: z.string().min(1).max(4096),
  sha256: hashSchema, byteLength: z.number().int().nonnegative().max(1_000_000_000),
  mediaType: z.string().min(1).max(128), title: z.string().min(1).max(240), provenance: provenanceSchema,
}).strict();
export type AssetRegistration = z.infer<typeof assetRegistrationSchema>;
export type AssetRecord = AssetRegistration & { createdAt: number };
export const sourceRegistrationSchema = z.object({
  id: idSchema, taskId: idSchema, title: z.string().min(1).max(240),
  url: z.string().url().max(4096).optional(), assetId: idSchema.optional(),
  excerpt: z.string().max(32_000), retrievedAt: timeSchema,
  timestampStart: z.number().nonnegative().optional(), timestampEnd: z.number().nonnegative().optional(),
  provenance: provenanceSchema,
}).strict().refine(value => value.url !== undefined || value.assetId !== undefined, 'A source needs a URL or imported asset')
  .refine(value => value.timestampEnd === undefined || (value.timestampStart !== undefined && value.timestampEnd >= value.timestampStart), 'Invalid source timestamp range');
export type SourceRegistration = z.infer<typeof sourceRegistrationSchema>;
export type SourceRecord = SourceRegistration & { createdAt: number };
export type CoreValueResult<T> = { ok: true; value: T } | CoreFailure;
export interface JobRecord { id: string; taskId: string; taskEpoch: number; generation: number; status: 'running' | 'cancelled' | 'completed'; createdAt: number; updatedAt: number }
export const jobRegistrationSchema = z.object({ id: idSchema, taskId: idSchema, taskEpoch: revisionSchema, generation: revisionSchema, provider: z.enum(['local', 'cloud']), background: z.boolean().default(false) }).strict();
export type JobRegistration = z.input<typeof jobRegistrationSchema>;

/** Registered UI components only: no scripts, CSS, or arbitrary executable component source. */
export const sceneRecipeSchema = z.object({
  version: z.literal(CONTRACT_VERSION), layout: z.enum(['work', 'inspect', 'learn', 'recall']),
  primary: activitySchema, supporting: activitySchema.optional(), taskId: idSchema,
}).strict();
export type SceneRecipe = z.infer<typeof sceneRecipeSchema>;
