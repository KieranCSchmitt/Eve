import { describe, expect, it } from 'vitest';
// Runtime project modules are intentionally plain browser JavaScript.
// @ts-expect-error JavaScript example has no generated declarations.
import { FocusTimer } from '../../examples/orbit/src/timer.mjs';

describe('Orbit elapsed-time clock', () => {
  it('uses elapsed time even when rendering is throttled for minutes', () => {
    let now = 1000;
    const timer = new FocusTimer(25, () => now);
    timer.start();
    now += 180123;
    expect(timer.snapshot().remaining).toBe(1500000 - 180123);
    expect(timer.snapshot().progress).toBeCloseTo(180123 / 1500000);
  });
  it('configures the next duration without changing a running or paused session', () => {
    let now = 0;
    const timer = new FocusTimer(25, () => now);
    timer.start(); now += 60000;
    timer.setNextDuration(45);
    expect(timer.snapshot().remaining).toBe(24 * 60000);
    timer.pause(); now += 60000;
    expect(timer.snapshot().remaining).toBe(24 * 60000);
    timer.reset();
    expect(timer.snapshot().remaining).toBe(45 * 60000);
  });
  it('finishes without producing negative time and can restart', () => {
    let now = 0;
    const timer = new FocusTimer(1, () => now);
    timer.start(); now += 100000;
    expect(timer.snapshot()).toMatchObject({ phase: 'complete', remaining: 0, progress: 1 });
    timer.start();
    expect(timer.snapshot()).toMatchObject({ phase: 'running', remaining: 60000 });
  });
});
