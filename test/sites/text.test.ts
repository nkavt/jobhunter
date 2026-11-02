import { describe, expect, it } from 'vitest';
import { clip, cut, wellFormed } from '../../src/sites/text.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cut and clip', () => {
  it('never splits an emoji in half', () => {
    // "🚀" is two UTF-16 units, at 11 and 12.
    const text = 'Senior dev 🚀 remote';
    expect(cut(text, 12)).toBe('Senior dev ');
    expect(cut(text, 13)).toBe('Senior dev 🚀');
    expect(clip(text, 13)).toBe('Senior dev …');
    for (let max = 1; max <= text.length; max++) expect(LONE.test(clip(text, max))).toBe(false);
  });

  it('leaves short text alone', () => {
    expect(clip('short', 10)).toBe('short');
  });
});

describe('wellFormed', () => {
  it('replaces lone halves and keeps whole emoji', () => {
    expect(wellFormed('a\uD83Db🚀c\uDE80')).toBe('a�b🚀c�');
  });
});
