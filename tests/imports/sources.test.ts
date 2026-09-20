import { describe, expect, it } from 'vitest';
import { normalizeVideoSource, normalizeWebSource } from '../../packages/imports/src/index';

describe('source attachments', () => {
  it('normalizes a web link without claiming to fetch its contents or grant rights', () => {
    const source = normalizeWebSource({ taskId: 't', url: 'https://EXAMPLE.com:443/article#part', title: ' Article ', attachedAt: 123 });
    expect(source).toMatchObject({ taskId: 't', url: 'https://example.com/article#part', title: 'Article', excerpt: '', retrievedAt: 123 });
    expect(source.provenance.attribution).toContain('not been verified'); expect(source.provenance.rights).toContain('No page, video, or transcript was downloaded');
  });
  it('preserves explicit excerpts and attribution instead of inventing them', () => {
    const source = normalizeWebSource({ taskId: 't', url: 'https://example.com', title: 'Reading', excerpt: 'User supplied passage', attribution: 'Author credited by user', rights: 'User supplied permission' });
    expect(source).toMatchObject({ excerpt: 'User supplied passage', provenance: { attribution: 'Author credited by user', rights: 'User supplied permission' } });
  });
  it('uses the shared official YouTube parser and preserves timestamp range', () => {
    const source = normalizeVideoSource({ taskId: 't', url: 'https://youtu.be/lVLzkleL_CE?t=1m30s&end=120', title: 'Lesson' });
    expect(source).toMatchObject({ url: 'https://www.youtube.com/watch?v=lVLzkleL_CE&t=90s', timestampStart: 90, timestampEnd: 120, excerpt: '' });
    expect(normalizeWebSource({ taskId: 't', url: 'https://youtube.com/shorts/lVLzkleL_CE', title: 'Lesson' }).timestampStart).toBe(0);
  });
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com', 'https://user:password@example.com', 'https://example.com/\nsecret'])('rejects unsafe source syntax %s', url => {
    expect(() => normalizeWebSource({ taskId: 't', url, title: 'x' })).toThrow();
  });
  it.each(['https://youtube.com.evil.test/watch?v=lVLzkleL_CE', 'https://youtube.com/playlist?list=x', 'https://youtu.be/lVLzkleL_CE?t=10&start=20'])('rejects unsupported or ambiguous video references %s', url => {
    expect(() => normalizeVideoSource({ taskId: 't', url, title: 'x' })).toThrow();
  });
});
