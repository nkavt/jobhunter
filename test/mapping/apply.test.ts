import { describe, expect, it } from 'vitest';
import {
  applyMapping,
  FeedMappingSchema,
  getPath,
  parseFeed,
  type FeedMapping,
} from '../../src/mapping/index.js';

const base = {
  sourceId: { from: 'id', transform: 'string' },
  url: 'link',
  title: 'name',
  company: 'org.name',
} satisfies FeedMapping['fields'];

describe('applyMapping', () => {
  it('reads nested item lists and dotted fields, and sets the source', () => {
    const feed = {
      data: {
        results: [{ id: 7, link: 'https://x.com/7', name: 'Engineer', org: { name: 'Acme' } }],
      },
    };
    const result = applyMapping(
      feed,
      { format: 'json', items: 'data.results', fields: base },
      'demo',
    );
    expect(result).toEqual({
      jobs: [
        {
          source: 'demo',
          sourceId: '7',
          url: 'https://x.com/7',
          title: 'Engineer',
          company: 'Acme',
          location: { regions: [] },
          description: '',
          tags: [],
        },
      ],
      errors: [],
      skipped: 0,
    });
  });

  it('supports constants, value maps, defaults and dotted targets', () => {
    const feed = [
      { id: 1, link: 'https://x.com/1', name: 'E', org: { name: 'A' }, kind: 'FT', pay: 90000 },
    ];
    const mapping: FeedMapping = {
      format: 'json',
      items: '',
      fields: {
        ...base,
        workMode: { const: 'remote' },
        employmentType: { from: 'kind', map: { FT: 'full_time' } },
        'salary.min': { from: 'pay', transform: 'positive' },
        'salary.currency': { const: 'EUR' },
        description: { from: 'missing', default: 'No description' },
      },
    };
    expect(applyMapping(feed, mapping, 'demo').jobs[0]).toMatchObject({
      workMode: 'remote',
      employmentType: 'full_time',
      salary: { min: 90000, currency: 'EUR' },
      description: 'No description',
    });
  });

  it('drops unmapped enum values instead of failing the job', () => {
    const feed = [
      { id: 1, link: 'https://x.com/1', name: 'E', org: { name: 'A' }, kind: 'Temporary' },
    ];
    const job = applyMapping(
      feed,
      {
        format: 'json',
        items: '',
        fields: { ...base, employmentType: { from: 'kind', map: { FT: 'full_time' } } },
      },
      'd',
    ).jobs[0];
    expect(job?.employmentType).toBeUndefined();
  });

  it('drops a salary that has only a currency or period', () => {
    const feed = [{ id: 1, link: 'https://x.com/1', name: 'E', org: { name: 'A' }, pay: 0 }];
    const mapping: FeedMapping = {
      format: 'json',
      items: '',
      fields: {
        ...base,
        'salary.min': { from: 'pay', transform: 'positive' },
        'salary.currency': { const: 'USD' },
      },
    };
    expect(applyMapping(feed, mapping, 'd').jobs[0]).not.toHaveProperty('salary');
  });

  it('skips entries that are not jobs, and reports invalid ones without stopping', () => {
    const feed = [
      { legal: 'Please link back' },
      { id: 1, link: 'https://x.com/1', name: 'Valid', org: { name: 'A' } },
      { id: 2, link: 'not-a-url', name: '', org: { name: 'B' } },
    ];
    const result = applyMapping(
      feed,
      { format: 'json', items: '', skipIf: { missing: 'id' }, fields: base },
      'd',
    );
    expect(result.skipped).toBe(1);
    expect(result.jobs.map((j) => j.title)).toEqual(['Valid']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(2);
    expect(result.errors[0]?.message).toMatch(/url:.*title:/);
  });

  it('treats a single XML item like a list of one, and an empty list as no jobs', () => {
    const xml = parseFeed(
      '<rss><channel><item><id>1</id><link>https://x.com/1</link><name>E</name><org><name>A</name></org></item></channel></rss>',
      'xml',
    );
    expect(
      applyMapping(xml, { format: 'xml', items: 'rss.channel.item', fields: base }, 'd').jobs,
    ).toHaveLength(1);
    expect(
      applyMapping({ jobs: [] }, { format: 'json', items: 'jobs', fields: base }, 'd').jobs,
    ).toEqual([]);
    expect(applyMapping({}, { format: 'json', items: 'jobs', fields: base }, 'd').jobs).toEqual([]);
  });
});

describe('getPath', () => {
  it('reads dot paths, returns the value itself for "", and unwraps XML text nodes', () => {
    expect(getPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getPath([1, 2], '')).toEqual([1, 2]);
    expect(getPath({ a: 'x' }, 'a.b')).toBeUndefined();
    expect(getPath({ guid: { '#text': 'https://x.com/1', '@_isPermaLink': 'true' } }, 'guid')).toBe(
      'https://x.com/1',
    );
  });
});

describe('parseFeed', () => {
  it('keeps XML values as text and decodes entities', () => {
    const feed = parseFeed('<r><id>007</id><d>&lt;p&gt;Hi&lt;/p&gt;</d></r>', 'xml') as {
      r: { id: string; d: string };
    };
    expect(feed.r).toEqual({ id: '007', d: '<p>Hi</p>' });
  });

  it('rejects bodies that are not the expected format', () => {
    expect(() => parseFeed('<html>', 'json')).toThrow("isn't valid JSON");
    expect(() => parseFeed('just text', 'xml')).toThrow("isn't valid XML");
  });
});

describe('FeedMappingSchema', () => {
  it('rejects unknown targets and transforms', () => {
    expect(
      FeedMappingSchema.safeParse({ format: 'json', items: '', fields: { title: 'name' } }).success,
    ).toBe(true);
    expect(
      FeedMappingSchema.safeParse({ format: 'json', items: '', fields: { salaryMin: 'x' } })
        .success,
    ).toBe(false);
    expect(
      FeedMappingSchema.safeParse({
        format: 'json',
        items: '',
        fields: { title: { from: 'x', transform: 'magic' } },
      }).success,
    ).toBe(false);
    expect(
      FeedMappingSchema.safeParse({
        format: 'json',
        items: '',
        fields: { title: { from: 'x', transform: 'after:: ' } },
      }).success,
    ).toBe(true);
  });
});
