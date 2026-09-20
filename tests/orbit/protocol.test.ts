import { describe, expect, it } from 'vitest';
import { FrameDecoder, MAX_FRAME_BYTES, encodeFrame } from '../../extensions/eve-workbench/src/protocol';

describe('Workbench stream framing', () => {
  it('reassembles split Unicode without corrupting authored text', () => {
    const decoder = new FrameDecoder();
    const data = Buffer.from(encodeFrame({ version: 1, type: 'event', event: 'context.changed', data: { text: 'café 🌿' } }));
    const split = data.indexOf(Buffer.from('🌿')) + 2;
    expect(decoder.feed(data.subarray(0, split))).toEqual([]);
    expect(decoder.feed(data.subarray(split))).toEqual([{ version: 1, type: 'event', event: 'context.changed', data: { text: 'café 🌿' } }]);
  });
  it('handles multiple frames and refuses unbounded input', () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed(Buffer.from('{"a":1}\n{"a":2}\n'))).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => decoder.feed(Buffer.alloc(MAX_FRAME_BYTES + 1, 65))).toThrow('size limit');
  });
});
