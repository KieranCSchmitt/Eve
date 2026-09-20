import { FocusTimer } from './timer.mjs';

const $ = id => document.getElementById(id);
const timer = new FocusTimer();
let config;
let lastPhase;
let lastSeconds;
const circumference = 2 * Math.PI * 122;

for (let index = 0; index < 60; index++) {
  const angle = index * Math.PI / 30;
  const inner = index % 5 === 0 ? 108 : 111;
  const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  tick.setAttribute('x1', String(140 + inner * Math.sin(angle)));
  tick.setAttribute('y1', String(140 - inner * Math.cos(angle)));
  tick.setAttribute('x2', String(140 + 114 * Math.sin(angle)));
  tick.setAttribute('y2', String(140 - 114 * Math.cos(angle)));
  $('ticks').append(tick);
}

function applyConfig(next) {
  config = next;
  document.documentElement.style.setProperty('--accent', next.theme);
  document.documentElement.style.setProperty('--transition', `${next.transitionMs}ms`);
  document.documentElement.style.setProperty('--easing', `cubic-bezier(${next.easing.join(',')})`);
  timer.setNextDuration(next.durationMinutes);
  $('duration-label').textContent = `${next.durationMinutes} MINUTES · JUST FOR YOU`;
  $('config-status').hidden = true;
  render();
}

function render() {
  const state = timer.snapshot();
  const seconds = Math.ceil(state.remaining / 1000);
  if (seconds !== lastSeconds) {
    $('time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('time').setAttribute('aria-label', `${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds remaining`);
    lastSeconds = seconds;
  }
  // Progress tracks elapsed time directly: decorative easing never changes time.
  $('progress').style.strokeDashoffset = String(circumference * state.progress);
  $('next-session').textContent = state.phase !== 'ready' && state.duration !== state.nextDuration ? `${state.nextDuration / 60000} minutes for your next session · Reset to start now` : '';
  if (state.phase !== lastPhase) {
    document.querySelector('.orbit').dataset.phase = state.phase;
    $('toggle-label').textContent = { ready: 'Begin session', running: 'Take a breath', paused: 'Keep going', complete: 'Begin again' }[state.phase];
    $('toggle-icon').textContent = state.phase === 'running' ? 'Ⅱ' : '↗';
    $('phase').textContent = { ready: 'FOCUS SESSION', running: 'IN YOUR ORBIT', paused: 'A MOMENT TO BREATHE', complete: 'BEAUTIFULLY DONE' }[state.phase];
    $('subtitle').textContent = state.phase === 'complete' ? 'you made room for what matters' : 'a little intention goes a long way';
    const note = { ready: ['A fresh start.', 'Make it a good one.'], running: ['You are right here.', 'That is enough.'], paused: ['Take your time.', 'Your place is waiting.'], complete: ['One thing, done.', 'A little closer than before.'] }[state.phase];
    $('session-note').replaceChildren(document.createTextNode(note[0]), document.createElement('br'), Object.assign(document.createElement('strong'), { textContent: note[1] }));
    lastPhase = state.phase;
  }
}

$('toggle').addEventListener('click', () => { timer.phase === 'running' ? timer.pause() : timer.start(); render(); });
$('reset').addEventListener('click', () => { timer.reset(); render(); });
function tick() { render(); requestAnimationFrame(tick); }
requestAnimationFrame(tick);

try {
  const response = await fetch('./eve.project.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Project configuration is unavailable.');
  applyConfig(await response.json());
} catch {
  $('config-status').hidden = false;
  $('config-status').textContent = 'The project configuration could not be loaded. Reopen the preview after fixing the file.';
  $('toggle').disabled = true;
}

const events = new EventSource('./events');
events.addEventListener('config', event => { $('toggle').disabled = false; applyConfig(JSON.parse(event.data).config); });
events.addEventListener('config-error', () => {
  $('config-status').hidden = false;
  $('config-status').textContent = 'The configuration has an error. Showing the last valid version while you edit.';
});
events.addEventListener('reload', () => {
  // Keep the running timer alive. New source code applies with a deliberate reload.
  $('config-status').hidden = false;
  $('config-status').textContent = 'Source updated. Reload the preview when you are ready to reset this session.';
});
events.addEventListener('error', () => {
  $('config-status').hidden = false;
  $('config-status').textContent = 'Preview connection interrupted. Your timer still works; reconnecting…';
});
