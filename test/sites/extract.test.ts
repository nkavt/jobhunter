import { describe, expect, it } from 'vitest';
import { parse } from 'node-html-parser';
import {
  feedLinks,
  findJobPosting,
  jobLinks,
  readJobPage,
  readSite,
  SiteError,
  type SiteMapping,
} from '../../src/sites/index.js';
import {
  ACME_SITE,
  fakeFetch,
  FEED_URL,
  FEED_XML,
  jobHtml,
  LIST_HTML,
  LIST_URL,
} from '../helpers/site-fixtures.js';

describe('jobLinks', () => {
  it('returns absolute links without fragments, each once, in page order', () => {
    expect(jobLinks(LIST_HTML, LIST_URL, 'a.job-link')).toEqual([
      'https://careers.acme.example/jobs/1',
      'https://careers.acme.example/jobs/2',
      'https://careers.acme.example/jobs/3',
    ]);
  });

  it('reads the link inside a matched card, and skips non-web links', () => {
    const html = `<div class="card"><a href="/a">A</a></div><div class="card"><a href="mailto:x@y.z">B</a></div>`;
    expect(jobLinks(html, 'https://x.example/', '.card')).toEqual(['https://x.example/a']);
  });
});

describe('findJobPosting', () => {
  it('finds a JobPosting inside @graph', () => {
    expect(findJobPosting(parse(jobHtml(1, 'Frontend Engineer')))).toMatchObject({
      title: 'Frontend Engineer',
    });
  });

  it('ignores broken JSON-LD and pages without a posting', () => {
    const html = `<script type="application/ld+json">{broken</script><script type="application/ld+json">{"@type":"Organization"}</script>`;
    expect(findJobPosting(parse(html))).toBeUndefined();
  });
});

describe('readJobPage', () => {
  const fields = ACME_SITE.list.kind === 'links' ? ACME_SITE.list.fields : {};

  it('reads selectors, JSON-LD paths and constants into a job', () => {
    const url = 'https://careers.acme.example/jobs/1';
    const page = readJobPage(jobHtml(1, 'Frontend Engineer'), url, fields, 'acme');
    expect(page.job).toMatchObject({
      source: 'acme',
      sourceId: url,
      url,
      title: 'Frontend Engineer',
      company: 'Acme',
      location: { text: 'Remote (EU)' },
      workMode: 'remote',
      postedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(page.job?.description).toContain('Build things at Acme, job 1.');
    expect(page.values.title).toBe('Frontend Engineer');
  });

  it('reports what was read when the page makes no valid job', () => {
    const page = readJobPage(
      jobHtml(1, 'Frontend Engineer', { jsonLd: false }),
      'https://careers.acme.example/jobs/1',
      fields,
      'acme',
    );
    expect(page.job).toBeUndefined();
    expect(page.error).toContain('title');
    expect(page.values.location).toBe('Remote (EU)');
  });

  it('treats an invalid selector as finding nothing', () => {
    const page = readJobPage(
      '<h1>Hi</h1>',
      'https://x.example/1',
      { title: { selector: 'h1[' } },
      'x',
    );
    expect(page.values.title).toBeUndefined();
  });
});

describe('readSite', () => {
  it('reads the list and each job page, skipping known ones and stopping at the limit', async () => {
    const fetch = fakeFetch();
    const result = await readSite(ACME_SITE, fetch, {
      maxPages: 1,
      skip: (url) => url.endsWith('/1'),
    });
    expect(result.links).toHaveLength(3);
    expect(result.jobs.map((job) => job.title)).toEqual(['Backend Engineer']);
    expect(fetch.urls).toEqual([LIST_URL, 'https://careers.acme.example/jobs/2']);
  });

  it('reports job pages that fail without failing the site', async () => {
    const fetch = fakeFetch({ [LIST_URL]: LIST_HTML });
    const result = await readSite(ACME_SITE, fetch);
    expect(result.jobs).toEqual([]);
    expect(result.errors[0]?.message).toContain('HTTP 404');
  });

  it('fails when the list itself fails', async () => {
    await expect(readSite(ACME_SITE, fakeFetch({}))).rejects.toThrow(SiteError);
  });

  it('reads a feed list with the feed mapping engine', async () => {
    const site: SiteMapping = {
      ...ACME_SITE,
      entryUrl: 'https://careers.acme.example/api/jobs',
      list: {
        kind: 'feed',
        mapping: {
          format: 'json',
          items: 'data.jobs',
          fields: {
            sourceId: { from: 'id', transform: 'string' },
            url: 'link',
            title: 'name',
            company: { const: 'Acme' },
          },
        },
      },
    };
    const body = JSON.stringify({
      data: {
        jobs: [{ id: 7, link: 'https://careers.acme.example/jobs/7', name: 'SRE' }, { id: 8 }],
      },
    });
    const result = await readSite(site, fakeFetch({ [site.entryUrl]: body }));
    expect(result.jobs).toMatchObject([{ sourceId: '7', title: 'SRE', company: 'Acme' }]);
    expect(result.errors).toHaveLength(1);
  });
});

describe('feedLinks', () => {
  it('reads RSS item links, absolute', () => {
    expect(
      feedLinks(FEED_XML, FEED_URL, { format: 'xml', items: 'rss.channel.item', link: 'link' }),
    ).toEqual(['https://careers.acme.example/jobs/1', 'https://careers.acme.example/jobs/2']);
  });

  it('reads Atom links from their href, and JSON items', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><link href="https://x.example/a"/></entry><entry><link href="https://x.example/b"/></entry>
    </feed>`;
    expect(
      feedLinks(atom, 'https://x.example/', { format: 'xml', items: 'feed.entry', link: 'link' }),
    ).toEqual(['https://x.example/a', 'https://x.example/b']);
    const json = JSON.stringify({ items: [{ url: '/c' }, { url: null }] });
    expect(
      feedLinks(json, 'https://x.example/', { format: 'json', items: 'items', link: 'url' }),
    ).toEqual(['https://x.example/c']);
  });
});

describe('readSite with links from a feed', () => {
  const fields = ACME_SITE.list.kind === 'links' ? ACME_SITE.list.fields : {};
  const site: SiteMapping = {
    ...ACME_SITE,
    entryUrl: FEED_URL,
    list: {
      kind: 'links',
      feed: { format: 'xml', items: 'rss.channel.item', link: 'link' },
      fields,
    },
  };

  it('reads each job from the page the feed links to', async () => {
    const result = await readSite(site, fakeFetch());
    expect(result.links).toHaveLength(2);
    expect(result.jobs.map((job) => [job.title, job.company])).toEqual([
      ['Frontend Engineer', 'Acme'],
      ['Backend Engineer', 'Acme'],
    ]);
  });

  it('fails when the feed is broken', async () => {
    await expect(
      readSite(
        {
          ...site,
          list: { kind: 'links', feed: { format: 'json', items: '', link: 'url' }, fields },
        },
        fakeFetch(),
      ),
    ).rejects.toThrow("isn't valid JSON");
  });
});
