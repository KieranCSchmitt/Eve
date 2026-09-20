import type {
  ContextSnapshot, RecognitionEvent, RecognitionSession, VoiceConfiguration,
  VoiceDependencies, VoiceOptions, VoiceSnapshot, VoiceState,
} from './contracts.js';

type Timer = ReturnType<typeof setTimeout>;

interface ActiveTurn {
  id: string;
  generation: number;
  context: ContextSnapshot;
  abort: AbortController;
  recognition?: RecognitionSession;
  timers: Set<Timer>;
  finalizationRequested: boolean;
  submitted: boolean;
}

const DEFAULT_CONFIGURATION: VoiceConfiguration = {
  enabled: false,
  configured: false,
  cloudSpeechAllowed: false,
  speakResponses: false,
};

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (typeof item !== 'object' || item === null) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  freeze(copy);
  return copy;
}

/** Push-to-talk lifecycle only. Providers never receive a second action system. */
export class VoiceSessionController {
  private configuration: VoiceConfiguration;
  private generation = 0;
  private active?: ActiveTurn;
  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>();
  private snapshot: VoiceSnapshot;
  private disposed = false;

  constructor(private readonly dependencies: VoiceDependencies, private readonly options: VoiceOptions = {}) {
    this.configuration = { ...DEFAULT_CONFIGURATION, ...options.configuration };
    this.snapshot = Object.freeze({
      state: this.restingState(), generation: 0, draft: '', playedMs: 0,
      capabilityLabel: this.capabilityLabel(),
    });
  }

  getSnapshot(): VoiceSnapshot { return this.snapshot; }

  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setConfiguration(configuration: Partial<VoiceConfiguration>): void {
    this.configuration = { ...this.configuration, ...configuration };
    if (!this.available()) this.stop('capability-disabled');
    else if (!this.active) this.publish({ state: this.restingState(), error: undefined });
    else this.publish({});
  }

  /** The context snapshot is taken before the first asynchronous operation. */
  async begin(): Promise<boolean> {
    if (this.disposed || !this.available()) return false;
    this.stop('superseded');
    let context: ContextSnapshot;
    try { context = frozenCopy(this.dependencies.captureContext()); }
    catch {
      this.publish({ state: 'unavailable', error: { code: 'context-unavailable', message: 'Select an activity before speaking.' } });
      return false;
    }
    const turn: ActiveTurn = {
      id: this.dependencies.createId?.() ?? globalThis.crypto.randomUUID(),
      generation: ++this.generation,
      context, abort: new AbortController(), timers: new Set(),
      finalizationRequested: false, submitted: false,
    };
    this.active = turn;
    this.publish({ state: 'preparing', generation: turn.generation, draft: '', context, error: undefined, playedMs: 0 });
    this.arm(turn, this.options.preparationTimeoutMs ?? 10_000,
      () => this.fail(turn, 'preparation-timeout', 'Voice did not become ready. Try again or type your request.'));

    try {
      if (context.media) {
        const paused = await this.dependencies.media.pause(context.media, turn.abort.signal);
        if (!this.current(turn)) return false;
        if (paused.videoId !== context.media.videoId || paused.state === 'playing') {
          throw new Error('media-not-paused');
        }
        turn.context = frozenCopy({ ...context, media: paused });
        this.publish({ context: turn.context });
      }
      if (!this.current(turn)) return false;
      const permission = await this.dependencies.capture.requestPermission(turn.abort.signal);
      if (!this.current(turn)) return false;
      if (permission !== 'granted') {
        this.fail(turn, 'permission-denied', 'Microphone access is unavailable. You can still type your request.');
        return false;
      }
      const recognition = await this.dependencies.recognizer.open({
        sessionId: turn.id, signal: turn.abort.signal,
        onEvent: event => this.recognitionEvent(turn, event),
      });
      if (!this.current(turn)) { recognition.cancel('cancelled-before-ready'); return false; }
      turn.recognition = recognition;
      await this.dependencies.capture.start({
        sessionId: turn.id, signal: turn.abort.signal,
        onFrame: frame => {
          if (!this.current(turn) || turn.finalizationRequested) return;
          try { turn.recognition?.feed(frame); }
          catch { this.fail(turn, 'audio-transfer-failed', 'Speech could not be captured completely. Try again or type your request.'); }
        },
        onDeviceLost: () => this.fail(turn, 'device-lost', 'The microphone disconnected. You can still type your request.'),
      });
      if (!this.current(turn)) { this.dependencies.capture.stop(turn.id); return false; }
      this.clearTimers(turn);
      this.publish({ state: 'listening' });
      this.arm(turn, this.options.maxRecordingMs ?? 60_000, () => { void this.release(); });
      return true;
    } catch {
      if (this.current(turn)) this.fail(turn, 'preparation-failed', 'Voice is unavailable. Try again or type your request.');
      return false;
    }
  }

  async release(): Promise<void> {
    const turn = this.active;
    if (!turn) return;
    if (this.snapshot.state === 'preparing') { this.stop('released-before-ready'); return; }
    if (this.snapshot.state !== 'listening' || !this.current(turn)) return;
    turn.finalizationRequested = true;
    this.clearTimers(turn);
    try { this.dependencies.capture.stop(turn.id); }
    catch {
      this.fail(turn, 'capture-stop-failed', 'The microphone could not be stopped cleanly. Your request was not submitted.');
      return;
    }
    this.publish({ state: 'finalizing' });
    this.arm(turn, this.options.finalizationTimeoutMs ?? 2_000,
      () => this.fail(turn, 'incomplete-transcript', 'The end of your speech was not confirmed. Edit the draft or try again.'));
    try { await turn.recognition?.finish(); }
    catch {
      if (this.current(turn)) this.fail(turn, 'finalization-failed', 'Speech could not be completed. Edit the draft or try again.');
    }
  }

  /** Use for Stop, lock/logout, permission revocation, or speech-worker failure. */
  stop(reason = 'user-stop'): void {
    if (this.active) this.teardown(this.active, reason);
    this.publish({ state: this.restingState(), generation: this.generation });
  }

  taskChanged(taskId: string, taskEpoch: number): void {
    const context = this.active?.context;
    if (context && (context.taskId !== taskId || context.taskEpoch !== taskEpoch)) this.stop('task-changed');
  }

  /** Resuming media is explicit user intent; never re-pause it to finish speaking. */
  mediaPlaybackStarted(): void { if (this.active) this.stop('media-resumed'); }

  dispose(): void {
    this.disposed = true;
    this.configuration.enabled = false;
    this.stop('disposed');
    this.listeners.clear();
  }

  private recognitionEvent(turn: ActiveTurn, event: RecognitionEvent): void {
    if (!this.current(turn)) return;
    if (turn.submitted) return;
    if (event.type === 'error') { this.fail(turn, event.code, event.message); return; }
    if (event.type === 'partial') { this.publish({ draft: event.text }); return; }
    // A provider's early endpoint must not turn a held microphone into an action.
    if (!turn.finalizationRequested) { this.publish({ draft: event.text }); return; }
    this.publish({ draft: event.text });
    if (!event.complete) {
      this.fail(turn, 'incomplete-transcript', 'Speech was incomplete. Edit the draft or try again.');
      return;
    }
    if (!event.text.trim()) { this.stop('empty-utterance'); return; }
    turn.submitted = true;
    this.clearTimers(turn);
    void this.submit(turn, event.text.trim());
  }

  private async submit(turn: ActiveTurn, text: string): Promise<void> {
    this.publish({ state: 'processing' });
    try {
      // Close the input transport now; a completed command must not upload background audio.
      turn.recognition?.cancel('transcription-complete');
      const response = await this.dependencies.submitIntent({
        id: turn.id, text, inputModality: 'voice', taskId: turn.context.taskId,
        taskEpoch: turn.context.taskEpoch, contextSnapshotId: turn.context.id,
        utteranceId: turn.id, generation: turn.generation,
      }, turn.context, turn.abort.signal);
      if (!this.current(turn)) return;
      if (response) {
        await this.dependencies.presenter.present(response, turn.context, turn.abort.signal);
        if (!this.current(turn)) return;
        if (this.configuration.speakResponses && response.spokenText && this.dependencies.synthesizer) {
          this.publish({ state: 'speaking' });
          await this.dependencies.synthesizer.speak({
            responseId: turn.id, text: response.spokenText, signal: turn.abort.signal,
            onProgress: playedMs => { if (this.current(turn)) this.publish({ playedMs }); },
          });
          if (!this.current(turn)) return;
        }
      }
      this.stop('completed');
    } catch {
      if (this.current(turn)) this.fail(turn, 'response-failed', 'The request could not be completed. Your draft is still available.');
    }
  }

  private current(turn: ActiveTurn): boolean {
    if (this.active !== turn || turn.abort.signal.aborted || this.disposed) return false;
    if (!this.dependencies.isCurrentTask(turn.context)) { this.stop('task-changed'); return false; }
    return true;
  }

  private fail(turn: ActiveTurn, code: string, message: string): void {
    if (this.active !== turn) return;
    this.teardown(turn, code);
    this.publish({ state: this.available() ? 'unavailable' : this.restingState(), generation: this.generation, error: { code, message } });
  }

  private teardown(turn: ActiveTurn, reason: string): void {
    this.active = undefined;
    this.generation++;
    this.clearTimers(turn);
    turn.abort.abort(reason);
    // A failed adapter cleanup must not prevent the other resources from stopping.
    for (const cleanup of [
      () => this.dependencies.capture.stop(turn.id),
      () => this.dependencies.synthesizer?.stop(turn.id),
      () => turn.recognition?.cancel(reason),
    ]) { try { cleanup(); } catch { /* All remaining cleanup still runs. */ } }
  }

  private arm(turn: ActiveTurn, ms: number, action: () => void): void {
    const timer = setTimeout(() => {
      turn.timers.delete(timer);
      if (this.current(turn)) action();
    }, ms);
    turn.timers.add(timer);
  }

  private clearTimers(turn: ActiveTurn): void {
    for (const timer of turn.timers) clearTimeout(timer);
    turn.timers.clear();
  }

  private available(): boolean {
    return this.configuration.enabled && this.configuration.configured &&
      (this.dependencies.recognizer.kind !== 'cloud' || this.configuration.cloudSpeechAllowed);
  }

  private restingState(): VoiceState {
    if (!this.configuration.enabled) return 'disabled';
    return this.available() ? 'idle' : 'unavailable';
  }

  private capabilityLabel(): string {
    if (!this.configuration.enabled || !this.configuration.configured) return 'Voice not configured';
    if (this.dependencies.recognizer.kind === 'cloud' && !this.configuration.cloudSpeechAllowed) return 'Cloud speech is disabled';
    return this.dependencies.recognizer.kind === 'test' ? 'Voice test adapter' : 'Voice ready';
  }

  private publish(patch: Partial<VoiceSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch, capabilityLabel: this.capabilityLabel() });
    for (const listener of this.listeners) {
      try { listener(this.snapshot); } catch { /* A presentation listener cannot alter voice lifecycle. */ }
    }
  }
}
