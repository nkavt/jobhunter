import { describe, expect, it } from 'vitest';
import { applyTransform } from '../../src/mapping/index.js';

describe('mapping transforms', () => {
  it('treats blank values as missing for every transform', () => {
    for (const blank of [undefined, null, '', '   ']) {
      expect(applyTransform(blank, 'string')).toBeUndefined();
      expect(applyTransform(blank, 'html')).toBeUndefined();
    }
  });

  it('converts strings and numbers', () => {
    expect(applyTransform(2086540, 'string')).toBe('2086540');
    expect(applyTransform('  Senior Engineer ', 'text')).toBe('Senior Engineer');
    expect(applyTransform('Full-Time', 'lowercase')).toBe('full-time');
    expect(applyTransform('120,000', 'number')).toBe(120000);
    expect(applyTransform('abc', 'number')).toBeUndefined();
    expect(applyTransform(0, 'positive')).toBeUndefined();
    expect(applyTransform('48', 'positive')).toBe(48);
  });

  it('reads dates: ISO with and without offset, RFC 822, epoch seconds', () => {
    expect(applyTransform('2026-10-08T21:47:32', 'date')).toBe('2026-10-08T21:47:32.000Z');
    expect(applyTransform('2026-10-10T08:00:08+00:00', 'date')).toBe('2026-10-10T08:00:08.000Z');
    expect(applyTransform('Sun, 11 Oct 2026 07:31:07 +0000', 'date')).toBe(
      '2026-10-11T07:31:07.000Z',
    );
    expect(applyTransform(1791619208, 'date')).toBe('2026-10-10T08:00:08.000Z');
    expect(applyTransform('not a date', 'date')).toBeUndefined();
  });

  it('splits "Company: Title" values', () => {
    expect(applyTransform('Vercel: Software Engineer - Data Platform', 'before:: ')).toBe('Vercel');
    expect(applyTransform('Vercel: Software Engineer - Data Platform', 'after:: ')).toBe(
      'Software Engineer - Data Platform',
    );
    expect(applyTransform('A: B: C', 'after:: ')).toBe('B: C');
    expect(applyTransform('No separator', 'before:: ')).toBeUndefined();
    expect(applyTransform('No separator', 'after:: ')).toBe('No separator');
  });

  it('builds lists from arrays or comma-separated text', () => {
    expect(applyTransform(['React', ' TS ', ''], 'list')).toEqual(['React', 'TS']);
    expect(applyTransform('React, Node.js,,AWS', 'list')).toEqual(['React', 'Node.js', 'AWS']);
  });

  it('delegates to the job helpers for html, location and salary text', () => {
    expect(applyTransform('<p>Hi&nbsp;there</p>', 'html')).toBe('Hi there');
    expect(applyTransform('North America Only', 'location')).toEqual({
      text: 'North America Only',
      regions: ['North America'],
    });
    expect(applyTransform('$80k - $150k', 'salaryText')).toMatchObject({
      min: 80000,
      max: 150000,
      currency: 'USD',
    });
  });

  it('guesses a salary period from the amount', () => {
    expect(applyTransform(48, 'periodFromAmount')).toBe('hour');
    expect(applyTransform(5000, 'periodFromAmount')).toBe('month');
    expect(applyTransform(200000, 'periodFromAmount')).toBe('year');
    expect(applyTransform(0, 'periodFromAmount')).toBeUndefined();
  });
});
