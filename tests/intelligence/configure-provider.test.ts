import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminal = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn(), spawn: vi.fn(), end: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: () => ({ question: terminal.question, close: terminal.close }) }));
vi.mock('node:child_process', () => ({ spawn: terminal.spawn }));
vi.mock('electron', () => ({ default: '/fixture/electron-not-executed' }));

let ttyDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  terminal.spawn.mockReturnValue({ stdin: { on: vi.fn(), end: terminal.end }, on: vi.fn() });
});
afterEach(() => {
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
});

async function configure(answers: string[]): Promise<void> {
  let next = 0;
  terminal.question.mockImplementation(async () => {
    if (next >= answers.length) throw new Error('Unexpected extra prompt');
    return answers[next++];
  });
  await import(new URL('../../scripts/configure-provider.mjs', import.meta.url).href);
  expect(next).toBe(answers.length);
}

describe('interactive provider configuration', () => {
  it.each(['', 'none'])('keeps the local chat effort choice %j explicit while authentication remains none', async effort => {
    await configure([effort ? 'local' : 'nemotron', 'qualified-model', 'http://127.0.0.1:8112/v1/chat/completions', 'openai-chat-completions', effort, 'json-schema', '8192', 'none', 'yes', 'explain']);
    const configuration = JSON.parse(terminal.end.mock.calls[0][0]);
    if (effort) expect(configuration.provider.reasoningEffort).toBe(effort);
    else expect(configuration.provider).not.toHaveProperty('reasoningEffort');
    expect(configuration.provider.authentication).toBe('none');
    expect(configuration.provider.kind).toBe('nemotron');
    expect(configuration.provider.maxOutputTokens).toBe(8192);
    expect(configuration).not.toHaveProperty('credential');
    expect(configuration.provider.cancellationMode).toBe('unverified');
    expect(terminal.question.mock.calls.some(([prompt]) => prompt.includes('qualified for this runtime/model'))).toBe(true);
    expect(terminal.spawn).toHaveBeenCalledExactlyOnceWith('/fixture/electron-not-executed', ['.', '--configure-provider'], expect.objectContaining({ stdio: ['pipe', 'inherit', 'inherit'] }));
    expect(terminal.close).toHaveBeenCalledOnce();
  });

  it('does not offer or send the chat-only setting for a local Responses runtime', async () => {
    await configure(['local', 'qualified-model', 'http://127.0.0.1:8112/v1/responses', 'openai-responses', 'json-schema', '8192', 'none', 'yes', 'explain']);
    expect(JSON.parse(terminal.end.mock.calls[0][0]).provider).not.toHaveProperty('reasoningEffort');
    expect(JSON.parse(terminal.end.mock.calls[0][0]).provider.maxOutputTokens).toBe(8192);
    expect(terminal.question.mock.calls.some(([prompt]) => prompt.includes('Reasoning effort'))).toBe(false);
  });

  it('rejects an unrecognized effort before spawning the credential process', async () => {
    await expect(configure(['nemotron', 'qualified-model', 'http://127.0.0.1:8112/v1/chat/completions', 'openai-chat-completions', 'xhigh'])).rejects.toThrow('Choose a qualified reasoning effort');
    expect(terminal.spawn).not.toHaveBeenCalled();
    expect(terminal.close).toHaveBeenCalledOnce();
  });

  it.each(['', '0', '16385', '1.5'])('rejects invalid output budget %j before spawning configuration', async budget => {
    await expect(configure(['local', 'qualified-model', 'http://127.0.0.1:8112/v1/chat/completions', 'openai-chat-completions', 'none', 'json-schema', budget])).rejects.toThrow('output-token budget');
    expect(terminal.spawn).not.toHaveBeenCalled();
    expect(terminal.close).toHaveBeenCalledOnce();
  });
});
