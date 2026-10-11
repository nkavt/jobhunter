import { describe, expect, it } from 'vitest';
import { squash, titleKeywords, titleMatches } from '../../src/filter/index.js';

const derived = {
  roles: ['Senior Frontend Engineer', 'Full-Stack Engineer', 'Software Engineer'],
  tech: { primary: ['TypeScript', 'React'], secondary: ['AWS'] },
};

describe('title keywords', () => {
  it('keeps what is distinctive in each role, plus primary technologies', () => {
    expect(titleKeywords(derived)).toEqual([
      'frontend',
      'fullstack',
      'softwareengineer',
      'typescript',
      'react',
    ]);
    expect(titleKeywords(derived, ['Vue.js'])).toContain('vuejs');
    expect(titleKeywords(undefined)).toEqual([]);
  });

  it('matches across spelling variants and seniority words', () => {
    const keywords = titleKeywords(derived);
    expect(titleMatches('Front-End Developer (React)', keywords)).toBe(true);
    expect(titleMatches('Senior Full Stack Developer', keywords)).toBe(true);
    expect(titleMatches('Software Engineer II, Payments', keywords)).toBe(true);
    expect(titleMatches('Inside Sales Contractor', keywords)).toBe(false);
    expect(titleMatches('Brand Design Lead', keywords)).toBe(false);
    expect(titleMatches('Software Sales Manager', keywords)).toBe(false);
  });

  it('keeps software engineering roles under other names for the AI to judge', () => {
    const keywords = titleKeywords(derived);
    expect(titleMatches('Product Engineer', keywords)).toBe(true);
    expect(titleMatches('Senior AI Engineer', keywords)).toBe(true);
    expect(titleMatches('Python Developer', keywords)).toBe(true);
    expect(titleMatches('Sales Engineer', keywords)).toBe(false);
    expect(titleMatches('Customer Support Engineer', keywords)).toBe(false);
    expect(titleMatches('Mechanical Engineer', keywords)).toBe(false);
    expect(titleMatches('Engineering Manager', keywords)).toBe(false);
  });

  it('lets everything through when there are no keywords', () => {
    expect(titleMatches('Anything', [])).toBe(true);
  });

  it('compares without case, spaces or dashes', () => {
    expect(squash('Full-Stack / Node.js')).toBe('fullstacknodejs');
  });
});
