import { describe, expect, it } from 'vitest';
import { toJsonSchema } from '../../src/llm/index.js';
import { draftToList, StepSchema } from '../../src/sites/index.js';
import { draft, field } from '../helpers/site-fixtures.js';

const links = draft({
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
});

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
    const { list } = draftToList(
      draft({
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
      }),
    );
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

  it('turns a links draft on a feed into feed links', () => {
    const { list } = draftToList({
      ...links,
      linkSelector: '',
      linkPath: 'link',
      format: 'xml',
      items: 'rss.channel.item',
    });
    expect(list).toMatchObject({
      kind: 'links',
      feed: { format: 'xml', items: 'rss.channel.item', link: 'link' },
    });
    expect(list).not.toHaveProperty('selector');
  });

  it('needs exactly one source of job links', () => {
    expect(draftToList({ ...links, linkPath: 'link' }).problems).toContain(
      'linkSelector / linkPath: give one when kind is "links": linkSelector for an HTML list, linkPath for a feed',
    );
  });

  it('lists every problem for the AI to fix', () => {
    const { problems } = draftToList({
      ...links,
      linkSelector: '',
      fields: [
        field({ target: 'title', selector: 'h1', jsonLd: 'title' }),
        field({ target: 'title', const: 'x' }),
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'fields: "title" is listed twice',
        'linkSelector / linkPath: give one when kind is "links": linkSelector for an HTML list, linkPath for a feed',
        'fields.title: give exactly one of selector, jsonLd and const (got 2)',
      ]),
    );
  });

  it('checks transform names', () => {
    const { problems } = draftToList(
      draft({ ...links, fields: [{ target: 'title', jsonLd: 'title', transforms: ['shout'] }] }),
    );
    expect(problems).toContain(
      'fields.title.transforms: "shout" is not a transform name or before:/after:<separator>',
    );
    expect(
      draftToList(
        draft({
          ...links,
          fields: [{ target: 'title', jsonLd: 'title', transforms: ['after:: '] }],
        }),
      ).list,
    ).toBeDefined();
  });

  it('needs a path or a constant for each feed field', () => {
    const { problems } = draftToList({
      ...links,
      kind: 'feed',
      fields: [field({ target: 'title' })],
    });
    expect(problems).toContain('fields.title: give exactly one of path and const');
  });
});

describe('StepSchema', () => {
  it('needs a url to fetch and a mapping to test', () => {
    const parse = (step: object) =>
      StepSchema.safeParse({ note: 'x', url: '', reason: '', ...step }).success;
    expect(parse({ action: 'fetch' })).toBe(false);
    expect(parse({ action: 'finish' })).toBe(false);
    expect(parse({ action: 'give_up', reason: 'login' })).toBe(true);
  });

  it('has no optional properties but the mapping, and no unions', () => {
    // Claude compiles the schema into a grammar; optional properties and unions blow it up.
    const schema = JSON.stringify(toJsonSchema(StepSchema));
    expect(schema).not.toContain('anyOf');
    expect(schema).not.toContain('oneOf');
    const optional: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      const { properties, required = [] } = node as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [key, child] of Object.entries(properties ?? {})) {
        if (!required.includes(key)) optional.push(`${path}${key}`);
        walk(child, `${path}${key}.`);
      }
      const { items } = node as { items?: unknown };
      if (items) walk(items, `${path}[].`);
    };
    walk(JSON.parse(schema), '');
    expect(optional).toEqual(['mapping']);
  });
});
