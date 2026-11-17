import { describe, expect, it } from 'vitest';
import {
  checkPageUrl,
  describeFeeds,
  digestPage,
  inspectPage,
  outline,
  pageFormat,
} from '../../src/sites/index.js';
import { FEED_XML, jobHtml, LIST_HTML, LIST_URL } from '../helpers/site-fixtures.js';

const page = (body: string, contentType = 'text/html') => ({
  url: LIST_URL,
  status: 200,
  contentType,
  body,
});

describe('digestPage', () => {
  it('shows forms, script endpoints, links and a collapsed outline of an HTML page', () => {
    const digest = digestPage(page(LIST_HTML));
    expect(digest).toContain('Title: Careers at Acme');
    expect(digest).toContain('GET https://careers.acme.example/jobs');
    expect(digest).toContain('team: one of =All, engineering=Engineering');
    expect(digest).toContain('/api/v2/jobs?team=engineering');
    expect(digest).toContain('Frontend Engineer → https://careers.acme.example/jobs/1');
    expect(digest).toContain('li.job');
    expect(digest).toContain('a.job-link href=/jobs/1 "Frontend Engineer"');
    expect(digest).toContain('… 2 more like this');
  });

  it('shows a JSON-LD JobPosting', () => {
    expect(digestPage(page(jobHtml(1, 'Frontend Engineer')))).toContain(
      'JSON-LD JobPosting (use with jsonLd paths)',
    );
  });

  it('outlines JSON responses by path', () => {
    const digest = digestPage(
      page(JSON.stringify({ jobs: [{ id: 1, title: 'SRE' }], total: 1 }), 'application/json'),
    );
    expect(digest).toContain('jobs: list of 1');
    expect(digest).toContain('jobs.0.title: "SRE"');
    expect(digest).toContain('total: 1');
  });

  it('says when a JSON response is broken', () => {
    expect(digestPage(page('{oops', 'application/json'))).toContain("isn't valid JSON");
  });
});

describe('inspectPage', () => {
  it('lists the feeds a page announces in its head, each once', () => {
    const view = inspectPage(page(LIST_HTML));
    expect(view.feeds).toEqual([
      { kind: 'RSS', url: 'https://careers.acme.example/jobs/feed/', title: 'Acme jobs' },
    ]);
    expect(view.digest).toContain(
      'Feeds announced by the page:\nRSS "Acme jobs" → https://careers.acme.example/jobs/feed/',
    );
    expect(view.summary).toBe('HTML page, 5 links, announces an RSS feed');
  });

  it('sums up feeds, JSON and failures in one line', () => {
    const summary = (body: string, contentType: string, status = 200) =>
      inspectPage({ ...page(body, contentType), status }).summary;
    expect(summary(FEED_XML, 'application/rss+xml')).toBe('RSS feed, 2 items');
    expect(
      summary(
        '<?xml version="1.0"?><feed><entry><title>a</title></entry></feed>',
        'application/atom+xml',
      ),
    ).toBe('Atom feed, 1 entries');
    expect(
      summary(JSON.stringify({ data: { jobs: [1, 2, 3] }, tags: [1] }), 'application/json'),
    ).toBe('JSON, list of 3 at data.jobs');
    expect(summary('[1, 2]', 'application/json')).toBe('JSON, list of 2');
    expect(summary('{oops', 'application/json')).toBe('broken JSON');
    expect(summary('Not found', 'text/html', 404)).toBe('HTTP 404');
    expect(summary(jobHtml(1, 'X'), 'text/html')).toBe('HTML page, 0 links, job posting data');
  });
});

describe('describeFeeds', () => {
  it('names one feed or several kinds', () => {
    expect(describeFeeds([{ kind: 'JSON' }])).toBe('a JSON feed');
    expect(describeFeeds([{ kind: 'RSS' }, { kind: 'Atom' }])).toBe('RSS and Atom feeds');
  });
});

describe('outline', () => {
  it('handles a list at the root and empty objects', () => {
    expect(outline([{ a: {} }])).toEqual(['(root): list of 1', '0.a: {}']);
  });
});

describe('pageFormat', () => {
  it('uses the content type, or the body when the type is generic', () => {
    expect(pageFormat({ contentType: 'application/ld+json', body: '' })).toBe('json');
    expect(pageFormat({ contentType: 'text/plain', body: ' [1]' })).toBe('json');
    expect(pageFormat({ contentType: '', body: '<?xml version="1.0"?><rss/>' })).toBe('xml');
    expect(pageFormat({ contentType: 'application/rss+xml', body: '' })).toBe('xml');
    expect(pageFormat({ contentType: '', body: '<html>' })).toBe('html');
  });
});

describe('checkPageUrl', () => {
  it('allows public web addresses only', () => {
    expect(checkPageUrl('https://jobs.example.com/')).toBeUndefined();
    expect(checkPageUrl('file:///etc/passwd')).toContain('Only http and https');
    expect(checkPageUrl('http://localhost:3000/')).toContain('your own machine');
    expect(checkPageUrl('http://192.168.1.1/')).toContain('your own machine');
    expect(checkPageUrl('not a url')).toContain("isn't a valid address");
  });
});
