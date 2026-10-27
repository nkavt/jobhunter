import { describe, expect, it } from 'vitest';
import { draftToList, StepSchema, type DraftMapping } from '../../src/sites/index.js';

const links: DraftMapping = {
  name: 'Acme',
  entryUrl: 'https://careers.acme.example/jobs',
  kind: 'links',
  linkSelector: 'a.job-link',
  fields: [
    { target: 'title', jsonLd: 'title', transforms: ['text'] },
    { target: 'company', const: 'Acme' },
    { target: 'description', selector: '.description', attr: 'html', transforms: ['html'] },
    { target: 'workMode', jsonLd: 'jobLocationType', map: [{ from: 'TELECOMMUTE', to: 'remote' }] },
  ],
};

describe('draftToList', () => {
  it('turns a links draft into page rules', () => {
    expect(draftToList(links).list).toEqual({
      kind: 'links',
      selector: 'a.job-link',
      fields: {
        title: { jsonLd: 'title', transform: 'text' },
        company: { const: 'Acme' },
        description: { selector: '.description', attr: 'html', transform: 'html' },
        workMode: { jsonLd: 'jobLocationType', map: { TELECOMMUTE: 'remote' } },
      },
    });
  });

  it('turns a feed draft into a feed mapping', () => {
    const { list } = draftToList({
      name: 'Acme',
      entryUrl: 'https://careers.acme.example/api/jobs',
      kind: 'feed',
      format: 'json',
      items: 'jobs',
      fields: [
        { target: 'title', path: 'name' },
        { target: 'company', const: 'Acme' },
        { target: 'postedAt', path: 'created', transforms: ['date'], default: '2026-01-01' },
      ],
    });
    expect(list).toEqual({
      kind: 'feed',
      mapping: {
        format: 'json',
        items: 'jobs',
        fields: {
          title: { from: 'name' },
          company: { const: 'Acme' },
          postedAt: { from: 'created', transform: 'date', default: '2026-01-01' },
        },
      },
    });
  });

  it('lists every problem for the AI to fix', () => {
    const { problems } = draftToList({
      ...links,
      linkSelector: undefined,
      fields: [
        { target: 'title', selector: 'h1', jsonLd: 'title' },
        { target: 'title', const: 'x' },
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'fields: "title" is listed twice',
        'linkSelector: required when kind is "links"',
        'fields.title: give exactly one of selector, jsonLd and const (got 2)',
      ]),
    );
  });

  it('needs a path or a constant for each feed field', () => {
    const { problems } = draftToList({
      ...links,
      kind: 'feed',
      fields: [{ target: 'title' }],
    });
    expect(problems).toContain('fields.title: give exactly one of path and const');
  });
});

describe('StepSchema', () => {
  it('needs a url to fetch and a mapping to test', () => {
    expect(StepSchema.safeParse({ note: 'x', action: 'fetch' }).success).toBe(false);
    expect(StepSchema.safeParse({ note: 'x', action: 'finish' }).success).toBe(false);
    expect(StepSchema.safeParse({ note: 'x', action: 'give_up', reason: 'login' }).success).toBe(
      true,
    );
  });
});
