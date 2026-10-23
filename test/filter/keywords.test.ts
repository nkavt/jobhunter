import { describe, expect, it } from 'vitest';
import { companyTitleFilter, squash, titleKeywords, titleMatches } from '../../src/filter/index.js';

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

  it('drops business developer titles, which are sales jobs', () => {
    const keywords = titleKeywords(derived);
    expect(titleMatches('Business Developer Representative (BDR)', keywords)).toBe(false);
    expect(titleMatches('Business Applications Developer', keywords)).toBe(true);
  });

  it('lets everything through when there are no keywords', () => {
    expect(titleMatches('Anything', [])).toBe(true);
  });

  it('compares without case, spaces or dashes', () => {
    expect(squash('Full-Stack / Node.js')).toBe('fullstacknodejs');
  });
});

describe('company board titles', () => {
  const senior = {
    roles: ['Senior Full-Stack Engineer', 'Senior Backend Engineer'],
    tech: { primary: ['Ruby on Rails', 'React', 'TypeScript'], secondary: ['PHP', 'JavaScript'] },
    seniority: 'senior' as const,
  };
  const keep = companyTitleFilter(senior);

  it('keeps the roles, main technologies and general software titles', () => {
    expect(keep('Senior Full Stack Engineer, AI Builder')).toBe(true);
    expect(keep('Backend Engineer (Ruby), Plan: Spec-Driven Development')).toBe(true);
    expect(keep('Senior Software Engineer, Payments')).toBe(true);
    expect(keep('Senior Software Engineer - Market Data')).toBe(true);
    expect(keep('Product Engineer - AI Neobank')).toBe(true);
    expect(keep('Founding Engineer ($3M pre-seed)')).toBe(true);
    expect(keep('Member of Technical Staff Backend')).toBe(true);
  });

  it('drops general titles that name another speciality', () => {
    expect(keep('Android Developer - AI Finance Agent')).toBe(false);
    expect(keep('Senior Software Engineer, Mobile')).toBe(false);
    expect(keep('Senior Data Engineer')).toBe(false);
    expect(keep('Machine Learning Engineer, Ranking & Retrieval')).toBe(false);
    expect(keep('Senior DevOps Engineer')).toBe(false);
    expect(keep('QA Automation Engineer')).toBe(false);
    expect(keep('Software Engineer - Go Specialist')).toBe(false);
    expect(keep('Senior Software Engineer (Java)')).toBe(false);
    expect(keep('Go-to-Market (GTM) Engineer')).toBe(false);
  });

  it('keeps specialities the CV names', () => {
    expect(keep('Senior PHP Developer')).toBe(true);
    expect(keep('Ruby Developer')).toBe(true);
    expect(
      companyTitleFilter({ ...senior, roles: ['Senior Data Engineer'] })('Staff Data Engineer'),
    ).toBe(true);
  });

  it('drops levels two or more away from the CV', () => {
    expect(keep('Backend Developer Intern, Winter 2027')).toBe(false);
    expect(keep('Jr. Full Stack Developer')).toBe(false);
    expect(keep('Full Stack Software Engineer, New Grad')).toBe(false);
    expect(keep('Junior/Mid Full Stack Software Engineer')).toBe(true);
    expect(keep('Mid-Level Full Stack Developer')).toBe(true);
    expect(keep('Principal Software Engineer')).toBe(true);

    const junior = companyTitleFilter({ ...senior, seniority: 'junior' });
    expect(junior('Junior Full Stack Developer')).toBe(true);
    expect(junior('Senior Full Stack Engineer')).toBe(false);
    expect(junior('Staff Software Engineer')).toBe(false);
  });

  it('only checks the level when there are no roles', () => {
    const keepAny = companyTitleFilter({
      roles: [],
      tech: { primary: [], secondary: [] },
      seniority: 'senior',
    });
    expect(keepAny('Account Executive')).toBe(true);
    expect(keepAny('Software Engineer Intern')).toBe(false);
    expect(companyTitleFilter(undefined)('Software Engineer Intern')).toBe(true);
  });
});
