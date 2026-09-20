/** The timer advances by elapsed monotonic time, never by counting animation frames. */
export class FocusTimer {
  constructor(durationMinutes = 25, clock = () => performance.now()) {
    this.clock = clock;
    this.nextDuration = durationMinutes * 60000;
    this.duration = this.nextDuration;
    this.elapsed = 0;
    this.startedAt = null;
    this.phase = 'ready';
  }
  setNextDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw new RangeError('Duration must be 1–180 minutes.');
    this.nextDuration = minutes * 60000;
    if (this.phase === 'ready') this.duration = this.nextDuration;
  }
  start() {
    if (this.phase === 'running') return;
    if (this.phase === 'complete') this.reset();
    this.startedAt = this.clock();
    this.phase = 'running';
  }
  pause() {
    if (this.phase !== 'running') return;
    this.elapsed = Math.min(this.duration, this.elapsed + this.clock() - this.startedAt);
    this.startedAt = null;
    this.phase = this.elapsed >= this.duration ? 'complete' : 'paused';
  }
  reset() {
    this.elapsed = 0;
    this.startedAt = null;
    this.duration = this.nextDuration;
    this.phase = 'ready';
  }
  snapshot() {
    const elapsed = Math.max(0, this.elapsed + (this.startedAt === null ? 0 : this.clock() - this.startedAt));
    const remaining = Math.max(0, this.duration - elapsed);
    if (remaining === 0 && this.phase === 'running') {
      this.elapsed = this.duration;
      this.startedAt = null;
      this.phase = 'complete';
    }
    return { phase: this.phase, remaining, duration: this.duration, progress: Math.min(1, elapsed / this.duration), nextDuration: this.nextDuration };
  }
}
