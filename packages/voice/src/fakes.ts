import type {
  AudioCapture, AudioFrame, RecognitionEvent, RecognitionSession,
  SpeechRecognizer, SpeechSynthesizer,
} from './contracts.js';

/** Explicit test doubles: no microphone, provider, or network is used. */
export class FakeAudioCapture implements AudioCapture {
  permission: 'granted' | 'denied' = 'granted';
  permissionRequests = 0;
  starts = 0;
  stops: string[] = [];
  permissionGate?: Promise<void>;
  startGate?: Promise<void>;
  readonly sessions = new Map<string, Parameters<AudioCapture['start']>[0]>();

  async requestPermission(_signal: AbortSignal): Promise<'granted' | 'denied'> {
    this.permissionRequests++;
    await this.permissionGate;
    return this.permission;
  }

  async start(options: Parameters<AudioCapture['start']>[0]): Promise<void> {
    this.starts++;
    await this.startGate;
    if (!options.signal.aborted) this.sessions.set(options.sessionId, options);
  }

  stop(sessionId: string): void { this.stops.push(sessionId); this.sessions.delete(sessionId); }
  frame(sessionId: string, frame: AudioFrame): void { this.sessions.get(sessionId)?.onFrame(frame); }
  loseDevice(sessionId: string): void { this.sessions.get(sessionId)?.onDeviceLost(); }
}

export class FakeRecognitionSession implements RecognitionSession {
  readonly frames: AudioFrame[] = [];
  finishCalls = 0;
  cancellations: string[] = [];
  finishGate?: Promise<void>;
  finalOnFinish?: Extract<RecognitionEvent, { type: 'final' }>;
  feedError?: Error;
  constructor(readonly id: string, private readonly onEvent: (event: RecognitionEvent) => void) {}
  feed(frame: AudioFrame): void {
    if (this.feedError) throw this.feedError;
    this.frames.push(frame);
  }
  async finish(): Promise<void> {
    this.finishCalls++;
    await this.finishGate;
    if (this.finalOnFinish) this.emit(this.finalOnFinish);
  }
  cancel(reason: string): void { this.cancellations.push(reason); this.frames.length = 0; }
  /** Deliberately permits late/duplicate events to exercise controller isolation. */
  emit(event: RecognitionEvent): void { this.onEvent(event); }
}

export class FakeSpeechRecognizer implements SpeechRecognizer {
  readonly kind: SpeechRecognizer['kind'];
  openCalls = 0;
  openGate?: Promise<void>;
  readonly sessions: FakeRecognitionSession[] = [];
  constructor(kind: SpeechRecognizer['kind'] = 'test') { this.kind = kind; }
  async open(options: Parameters<SpeechRecognizer['open']>[0]): Promise<RecognitionSession> {
    this.openCalls++;
    await this.openGate;
    const session = new FakeRecognitionSession(options.sessionId, options.onEvent);
    this.sessions.push(session);
    return session;
  }
  get latest(): FakeRecognitionSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error('No fake recognition session was opened.');
    return session;
  }
}

export class FakeSpeechSynthesizer implements SpeechSynthesizer {
  readonly requests: Parameters<SpeechSynthesizer['speak']>[0][] = [];
  readonly stops: string[] = [];
  readonly playing = new Set<string>();
  private readonly completions = new Map<string, () => void>();
  async speak(options: Parameters<SpeechSynthesizer['speak']>[0]): Promise<void> {
    this.requests.push(options);
    if (options.signal.aborted) return;
    this.playing.add(options.responseId);
    await new Promise<void>(resolve => { this.completions.set(options.responseId, resolve); });
    this.playing.delete(options.responseId);
  }
  stop(responseId: string): void {
    this.stops.push(responseId);
    this.playing.delete(responseId);
    this.complete(responseId);
  }
  progress(responseId: string, playedMs: number): void {
    this.requests.find(request => request.responseId === responseId)?.onProgress(playedMs);
  }
  complete(responseId: string): void {
    this.completions.get(responseId)?.();
    this.completions.delete(responseId);
  }
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
