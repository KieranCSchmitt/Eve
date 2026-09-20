import type { ContextSnapshot, IntentRequest } from '../../contracts/src/index.js';

export type { ContextSnapshot, IntentRequest };

export type VoiceState =
  | 'disabled' | 'idle' | 'preparing' | 'listening' | 'finalizing'
  | 'processing' | 'speaking' | 'unavailable';

export interface AudioFrame {
  /** Monotonic position within this capture, not a wall-clock timestamp. */
  sequence: number;
  startTimeMs: number;
  sampleRate: number;
  channels: number;
  pcm: Int16Array;
}

export interface AudioCapture {
  requestPermission(signal: AbortSignal): Promise<'granted' | 'denied'>;
  /** Must honour cancellation even if permission or device opening resolves late. */
  start(options: {
    sessionId: string;
    signal: AbortSignal;
    onFrame: (frame: AudioFrame) => void;
    onDeviceLost: () => void;
  }): Promise<void>;
  /** Synchronously stop every track for this session, including a pending start. */
  stop(sessionId: string): void;
}

export type RecognitionEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; turnId: string; complete: boolean }
  | { type: 'error'; code: string; message: string };

export interface RecognitionSession {
  /** The adapter owns bounded buffering; overload must fail rather than drop speech. */
  feed(frame: AudioFrame): void;
  /** Drain the audio tail, then emit one complete final, or an error. */
  finish(): Promise<void>;
  /** Stop uploads, close the socket, and clear queued audio. Must be idempotent. */
  cancel(reason: string): void;
}

export interface SpeechRecognizer {
  readonly kind: 'cloud' | 'local' | 'test';
  open(options: {
    sessionId: string;
    signal: AbortSignal;
    onEvent: (event: RecognitionEvent) => void;
  }): Promise<RecognitionSession>;
}

export interface SpeechSynthesizer {
  /** Resolves after local playback finishes; never invokes actions or reasoning. */
  speak(options: {
    responseId: string;
    text: string;
    signal: AbortSignal;
    onProgress: (playedMs: number) => void;
  }): Promise<void>;
  /** Clear local output immediately; provider reconciliation happens inside the adapter. */
  stop(responseId: string): void;
}

export interface VoiceResponse {
  text: string;
  /** An optional concise rendering of the already committed response. */
  spokenText?: string;
}

export interface ResponsePresenter {
  /** Complete only when this generation's visible response is available. */
  present(response: VoiceResponse, context: ContextSnapshot, signal: AbortSignal): Promise<void> | void;
}

export interface MediaFocus {
  /** Pause this exact media reference; do not look up whichever view is active later. */
  pause(media: NonNullable<ContextSnapshot['media']>, signal: AbortSignal):
    Promise<NonNullable<ContextSnapshot['media']>>;
}

export interface VoiceConfiguration {
  enabled: boolean;
  configured: boolean;
  cloudSpeechAllowed: boolean;
  speakResponses: boolean;
}

export interface VoiceSnapshot {
  state: VoiceState;
  generation: number;
  draft: string;
  context?: Readonly<ContextSnapshot>;
  error?: { code: string; message: string };
  playedMs: number;
  capabilityLabel: string;
}

export interface VoiceDependencies {
  capture: AudioCapture;
  recognizer: SpeechRecognizer;
  synthesizer?: SpeechSynthesizer;
  presenter: ResponsePresenter;
  media: MediaFocus;
  /** Called synchronously before permission, connection, or media awaits. */
  captureContext(): ContextSnapshot;
  /** Check task identity/epoch only; the broker separately checks artifact revisions. */
  isCurrentTask(context: ContextSnapshot): boolean;
  /** The same normal intent entry point used by typed requests. */
  submitIntent(request: IntentRequest, context: ContextSnapshot, signal: AbortSignal):
    Promise<VoiceResponse | void>;
  createId?: () => string;
}

export interface VoiceOptions {
  configuration?: Partial<VoiceConfiguration>;
  preparationTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  maxRecordingMs?: number;
}
