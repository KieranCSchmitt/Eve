import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { requestPublicPage } from '../../packages/imports/src/web-reader';

function reply(contentType: string, body: string, contentLength?: string) {
  mocks.request.mockImplementation((_url, _options, callback) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void };
    outgoing.end = () => queueMicrotask(() => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': contentType, ...(contentLength ? { 'content-length': contentLength } : {}) } });
      callback(response);
      if (!response.destroyed) response.end(body);
    });
    return outgoing;
  });
}

describe('article reader network transport', () => {
  beforeEach(() => { mocks.lookup.mockReset(); mocks.request.mockReset(); });
  it('rejects mixed public/private DNS results before opening a connection', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(requestPublicPage(new URL('https://example.com'), new AbortController().signal)).rejects.toThrow(/public website/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('pins the validated address for the socket without making a second DNS lookup', async () => {
    mocks.lookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }]);
    reply('text/html', '<p>Actual response</p>');
    const response = await requestPublicPage(new URL('https://example.com/article'), new AbortController().signal);
    expect(response.body).toBe('<p>Actual response</p>');
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    const options = mocks.request.mock.calls[0]![1] as { lookup: LookupFunction; agent: boolean; headers: Record<string, string> };
    const callback = vi.fn();
    options.lookup('example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }], 4);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(options.agent).toBe(false);
    expect(options.headers).not.toHaveProperty('Cookie');
    expect(options.headers).not.toHaveProperty('Authorization');
  });
  it('checks response types and advertised byte limits before consuming body data', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    reply('application/octet-stream', 'arbitrary binary content');
    await expect(requestPublicPage(new URL('https://example.com'), new AbortController().signal)).rejects.toThrow(/not a readable text page/);
    reply('text/html', 'oversized', '3000000');
    await expect(requestPublicPage(new URL('https://example.com'), new AbortController().signal)).rejects.toThrow(/too large/);
  });
  it('bounds streamed bodies even when Content-Length is absent', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    reply('text/html', 'x'.repeat(2_000_001));
    await expect(requestPublicPage(new URL('https://example.com'), new AbortController().signal)).rejects.toThrow(/too large/);
  });
});
