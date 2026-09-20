import { afterEach, describe, expect, it, vi } from 'vitest';
import { intentRequestSchema } from '../../packages/contracts/src/index.js';
import {
  VoiceSessionController, FakeAudioCapture, FakeSpeechRecognizer,
  FakeSpeechSynthesizer, deferred,
} from '../../packages/voice/src/index.js';
import type {
  ContextSnapshot, VoiceDependencies, VoiceOptions, VoiceResponse,
} from '../../packages/voice/src/index.js';

const controllers: VoiceSessionController[] = [];

function fixture(options: VoiceOptions = {}, kind: 'test' | 'cloud' = 'test') {
  const capture = new FakeAudioCapture();
  const recognizer = new FakeSpeechRecognizer(kind);
  const synthesizer = new FakeSpeechSynthesizer();
  const selected: ContextSnapshot = {
    id: 'context-1', taskId: 'task-1', taskEpoch: 1, createdAt: 100,
    selection: { artifactId: 'note-1', revision: 2, text: 'selected text' },
  };
  let activeTaskId = selected.taskId;
  let activeEpoch = selected.taskEpoch;
  let id = 0;
  const submitIntent = vi.fn<VoiceDependencies['submitIntent']>().mockResolvedValue({ text: 'Visible answer', spokenText: 'Spoken answer' });
  const present = vi.fn<VoiceDependencies['presenter']['present']>();
  const pause = vi.fn<VoiceDependencies['media']['pause']>().mockImplementation(async media => ({ ...media, currentTime: 12.5, state: 'paused' }));
  const captureContext = vi.fn(() => selected);
  const controller = new VoiceSessionController({
    capture, recognizer, synthesizer, presenter: { present }, media: { pause },
    captureContext, submitIntent, createId: () => `utterance-${++id}`,
    isCurrentTask: context => context.taskId === activeTaskId && context.taskEpoch === activeEpoch,
  }, { ...options, configuration: { enabled: true, configured: true, cloudSpeechAllowed: true, ...options.configuration } });
  controllers.push(controller);
  return {
    controller, capture, recognizer, synthesizer, selected, submitIntent, present, pause, captureContext,
    changeTask(taskId: string, epoch: number) { activeTaskId = taskId; activeEpoch = epoch; },
  };
}

async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

async function finish(f: ReturnType<typeof fixture>, text = 'Explain this'): Promise<void> {
  await f.controller.release();
  f.recognizer.latest.emit({ type: 'final', text, turnId: 'provider-turn-1', complete: true });
  await flush();
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe('voice capability and capture', () => {
  it('does not access permission, microphone, or provider when disabled or unconfigured', async () => {
    for (const configuration of [{ enabled: false }, { configured: false }]) {
      const f = fixture({ configuration });
      expect(await f.controller.begin()).toBe(false);
      expect(f.capture.permissionRequests).toBe(0);
      expect(f.capture.starts).toBe(0);
      expect(f.recognizer.openCalls).toBe(0);
      expect(f.captureContext).not.toHaveBeenCalled();
      expect(f.controller.getSnapshot().capabilityLabel).toBe('Voice not configured');
    }
  });

  it('enforces the separate cloud-speech policy', async () => {
    const f = fixture({ configuration: { cloudSpeechAllowed: false } }, 'cloud');
    expect(await f.controller.begin()).toBe(false);
    expect(f.capture.permissionRequests).toBe(0);
    expect(f.recognizer.openCalls).toBe(0);
    expect(f.controller.getSnapshot().capabilityLabel).toBe('Cloud speech is disabled');
  });

  it('freezes the selected target before permission resolves', async () => {
    const f = fixture();
    const gate = deferred();
    f.capture.permissionGate = gate.promise;
    const starting = f.controller.begin();
    expect(f.captureContext).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().state).toBe('preparing');
    f.selected.selection!.artifactId = 'different-note';
    f.selected.selection!.text = 'different text';
    gate.resolve();
    expect(await starting).toBe(true);
    await finish(f);
    const context = f.submitIntent.mock.calls[0]![1];
    expect(context.selection).toEqual({ artifactId: 'note-1', revision: 2, text: 'selected text' });
    expect(Object.isFrozen(context.selection)).toBe(true);
  });

  it('a release during preparation never starts a delayed recording or connection', async () => {
    const f = fixture();
    const gate = deferred();
    f.capture.permissionGate = gate.promise;
    const starting = f.controller.begin();
    await f.controller.release();
    gate.resolve();
    expect(await starting).toBe(false);
    expect(f.capture.starts).toBe(0);
    expect(f.recognizer.openCalls).toBe(0);
    expect(f.controller.getSnapshot().state).toBe('idle');
  });

  it('closes a provider that resolves after cancellation', async () => {
    const f = fixture();
    const gate = deferred();
    f.recognizer.openGate = gate.promise;
    const starting = f.controller.begin();
    await flush();
    expect(f.recognizer.openCalls).toBe(1);
    f.controller.stop('locked');
    gate.resolve();
    expect(await starting).toBe(false);
    expect(f.recognizer.latest.cancellations).toContain('cancelled-before-ready');
    expect(f.capture.starts).toBe(0);
  });

  it('denied permission preserves typed usability without opening a provider', async () => {
    const f = fixture();
    f.capture.permission = 'denied';
    expect(await f.controller.begin()).toBe(false);
    expect(f.recognizer.openCalls).toBe(0);
    expect(f.controller.getSnapshot().error?.code).toBe('permission-denied');
  });
});

describe('voice finalization and ordinary intent dispatch', () => {
  it('keeps partial and premature final transcripts as drafts without dispatching', async () => {
    const f = fixture();
    await f.controller.begin();
    f.recognizer.latest.emit({ type: 'partial', text: 'Explain' });
    f.recognizer.latest.emit({ type: 'partial', text: 'Explain the easing' });
    f.recognizer.latest.emit({ type: 'final', text: 'Explain the easing', turnId: 'early', complete: true });
    expect(f.controller.getSnapshot().draft).toBe('Explain the easing');
    expect(f.controller.getSnapshot().state).toBe('listening');
    expect(f.submitIntent).not.toHaveBeenCalled();
  });

  it('dispatches a schema-valid normal intent exactly once despite duplicate finals', async () => {
    const f = fixture();
    const response = deferred<VoiceResponse>();
    f.submitIntent.mockReturnValue(response.promise);
    await f.controller.begin();
    await f.controller.release();
    const final = { type: 'final' as const, text: '  Explain this  ', turnId: 'same-final', complete: true };
    f.recognizer.latest.emit(final);
    f.recognizer.latest.emit(final);
    f.recognizer.latest.emit({ ...final, turnId: 'different-duplicate' });
    expect(f.submitIntent).toHaveBeenCalledOnce();
    const request = f.submitIntent.mock.calls[0]![0];
    expect(intentRequestSchema.parse(request)).toEqual(request);
    expect(request).toMatchObject({ text: 'Explain this', inputModality: 'voice', taskId: 'task-1', taskEpoch: 1, contextSnapshotId: 'context-1', utteranceId: 'utterance-1' });
    expect(f.capture.sessions.size).toBe(0);
    response.resolve({ text: 'Answer' });
    await flush();
    f.recognizer.latest.emit(final);
    expect(f.submitIntent).toHaveBeenCalledOnce();
  });

  it('retains an incomplete transcript for editing without submitting', async () => {
    const f = fixture();
    await f.controller.begin();
    await f.controller.release();
    f.recognizer.latest.emit({ type: 'final', text: 'Change it to', turnId: 'incomplete', complete: false });
    expect(f.submitIntent).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().draft).toBe('Change it to');
    expect(f.controller.getSnapshot().error?.code).toBe('incomplete-transcript');
    expect(f.capture.sessions.size).toBe(0);
  });

  it('times out a missing final and ignores one that arrives afterward', async () => {
    vi.useFakeTimers();
    const f = fixture({ finalizationTimeoutMs: 25 });
    await f.controller.begin();
    f.recognizer.latest.emit({ type: 'partial', text: 'The saved draft' });
    await f.controller.release();
    await vi.advanceTimersByTimeAsync(26);
    f.recognizer.latest.emit({ type: 'final', text: 'Late final', turnId: 'late', complete: true });
    expect(f.submitIntent).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().draft).toBe('The saved draft');
    expect(f.controller.getSnapshot().error?.code).toBe('incomplete-transcript');
  });

  it('does not submit an empty utterance', async () => {
    const f = fixture();
    await f.controller.begin();
    await finish(f, '  ');
    expect(f.submitIntent).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().state).toBe('idle');
  });
});

describe('context continuity, cancellation, and playback', () => {
  it('pauses the original media and uses its acknowledged timestamp', async () => {
    const f = fixture();
    f.selected.media = { videoId: 'original-video', currentTime: 10, state: 'playing' };
    const gate = deferred<NonNullable<ContextSnapshot['media']>>();
    f.pause.mockReturnValue(gate.promise);
    const starting = f.controller.begin();
    f.selected.media.videoId = 'other-video';
    gate.resolve({ videoId: 'original-video', currentTime: 11.2, state: 'paused' });
    await starting;
    await finish(f);
    expect(f.pause.mock.calls[0]![0].videoId).toBe('original-video');
    expect(f.submitIntent.mock.calls[0]![1].media).toEqual({ videoId: 'original-video', currentTime: 11.2, state: 'paused' });
  });

  it('cancels preparation if the task changes without a caller notification', async () => {
    const f = fixture();
    const gate = deferred();
    f.capture.permissionGate = gate.promise;
    const starting = f.controller.begin();
    f.changeTask('task-2', 2);
    gate.resolve();
    expect(await starting).toBe(false);
    expect(f.recognizer.openCalls).toBe(0);
    expect(f.capture.starts).toBe(0);
  });

  it('aborts an in-flight request on a task change and suppresses its late response', async () => {
    const f = fixture();
    const response = deferred<VoiceResponse>();
    f.submitIntent.mockReturnValue(response.promise);
    await f.controller.begin();
    await finish(f);
    const signal = f.submitIntent.mock.calls[0]![2];
    f.controller.taskChanged('task-2', 1);
    expect(signal.aborted).toBe(true);
    response.resolve({ text: 'Stale answer', spokenText: 'Stale speech' });
    await flush();
    expect(f.present).not.toHaveBeenCalled();
    expect(f.synthesizer.requests).toHaveLength(0);
  });

  it('disabling voice stops capture and closes the cloud connection without reconnecting', async () => {
    const f = fixture({}, 'cloud');
    await f.controller.begin();
    f.controller.setConfiguration({ enabled: false });
    expect(f.capture.sessions.size).toBe(0);
    expect(f.recognizer.latest.cancellations).toContain('capability-disabled');
    expect(f.controller.getSnapshot().state).toBe('disabled');
    expect(await f.controller.begin()).toBe(false);
    expect(f.recognizer.openCalls).toBe(1);
  });

  it('revoking cloud speech while listening closes the active connection', async () => {
    const f = fixture({}, 'cloud');
    await f.controller.begin();
    f.controller.setConfiguration({ cloudSpeechAllowed: false });
    expect(f.capture.sessions.size).toBe(0);
    expect(f.recognizer.latest.cancellations).toContain('capability-disabled');
    expect(f.controller.getSnapshot().state).toBe('unavailable');
  });

  it('device loss preserves the draft and rejects late transcript events', async () => {
    const f = fixture();
    await f.controller.begin();
    f.recognizer.latest.emit({ type: 'partial', text: 'Useful draft' });
    f.capture.loseDevice('utterance-1');
    f.recognizer.latest.emit({ type: 'final', text: 'Unsafe late command', turnId: 'late', complete: true });
    expect(f.capture.sessions.size).toBe(0);
    expect(f.controller.getSnapshot().draft).toBe('Useful draft');
    expect(f.controller.getSnapshot().error?.code).toBe('device-lost');
    expect(f.submitIntent).not.toHaveBeenCalled();
  });

  it('network failure clears queued audio and never reconnects in the background', async () => {
    const f = fixture({}, 'cloud');
    await f.controller.begin();
    const session = f.recognizer.latest;
    f.capture.frame('utterance-1', { sequence: 0, startTimeMs: 0, sampleRate: 16000, channels: 1, pcm: new Int16Array(1280) });
    expect(session.frames).toHaveLength(1);
    session.emit({ type: 'partial', text: 'Keep this draft' });
    session.emit({ type: 'error', code: 'network-lost', message: 'Speech connection lost.' });
    await flush();
    expect(session.frames).toHaveLength(0);
    expect(f.capture.sessions.size).toBe(0);
    expect(f.recognizer.openCalls).toBe(1);
    expect(f.controller.getSnapshot().draft).toBe('Keep this draft');
    expect(f.controller.getSnapshot().state).toBe('unavailable');
  });

  it('audio transfer overload cancels instead of transcribing a stream with dropped frames', async () => {
    const f = fixture();
    await f.controller.begin();
    f.recognizer.latest.feedError = new Error('bounded audio queue exceeded');
    f.capture.frame('utterance-1', { sequence: 0, startTimeMs: 0, sampleRate: 16000, channels: 1, pcm: new Int16Array(1280) });
    expect(f.controller.getSnapshot().error?.code).toBe('audio-transfer-failed');
    expect(f.capture.sessions.size).toBe(0);
    expect(f.submitIntent).not.toHaveBeenCalled();
  });

  it('shows the answer before speaking and interrupts locally before another preparation awaits', async () => {
    const f = fixture({ configuration: { speakResponses: true } });
    const visible = deferred();
    f.present.mockReturnValue(visible.promise);
    await f.controller.begin();
    await finish(f);
    expect(f.synthesizer.requests).toHaveLength(0);
    visible.resolve();
    await flush();
    expect(f.controller.getSnapshot().state).toBe('speaking');
    expect(f.synthesizer.playing.has('utterance-1')).toBe(true);
    const gate = deferred();
    f.capture.permissionGate = gate.promise;
    const starting = f.controller.begin();
    expect(f.synthesizer.playing.size).toBe(0);
    f.synthesizer.progress('utterance-1', 5000);
    expect(f.controller.getSnapshot().playedMs).toBe(0);
    gate.resolve();
    await starting;
  });

  it('resuming media stops speech and never restarts it', async () => {
    const f = fixture({ configuration: { speakResponses: true } });
    await f.controller.begin();
    await finish(f);
    expect(f.synthesizer.playing.size).toBe(1);
    f.controller.mediaPlaybackStarted();
    expect(f.synthesizer.playing.size).toBe(0);
    await flush();
    expect(f.controller.getSnapshot().state).toBe('idle');
    expect(f.synthesizer.requests).toHaveLength(1);
  });
});
