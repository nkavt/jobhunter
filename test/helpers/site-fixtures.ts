import type {
  DraftField,
  DraftMapping,
  FetchPage,
  Page,
  SiteMapping,
  Step,
} from '../../src/sites/index.js';

export const LIST_URL = 'https://careers.acme.example/jobs?team=engineering';

export const LIST_HTML = `<!doctype html>
<html><head><title>Careers at Acme</title>
<link rel="alternate" type="application/rss+xml" title="Acme jobs" href="/jobs/feed/">
<link rel="alternate" type="application/rss+xml" title="Acme jobs" href="/jobs/feed/">
<link rel="alternate" type="application/rss+xml" title="Acme » Comments Feed" href="/comments/feed/">
<link rel="stylesheet" href="/style.css">
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <form action="/jobs" method="get">
    <select name="team"><option value="">All</option><option value="engineering">Engineering</option></select>
    <input type="checkbox" name="remote" value="1">
  </form>
  <ul class="jobs">
    <li class="job"><a class="job-link" href="/jobs/1">Frontend Engineer</a></li>
    <li class="job"><a class="job-link" href="/jobs/2#apply">Backend Engineer</a></li>
    <li class="job"><a class="job-link" href="/jobs/1">Frontend Engineer</a></li>
    <li class="job"><a class="job-link" href="https://careers.acme.example/jobs/3">Designer</a></li>
  </ul>
  <script>fetch("/api/v2/jobs?team=engineering")</script>
</body></html>`;

export function jobHtml(id: number, title: string, { jsonLd = true } = {}): string {
  const posting = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Acme' },
      {
        '@type': 'JobPosting',
        title,
        datePosted: '2026-10-20',
        hiringOrganization: { '@type': 'Organization', name: 'Acme Inc.' },
        jobLocationType: 'TELECOMMUTE',
      },
    ],
  };
  return `<html><body>
    ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(posting)}</script>` : ''}
    <h1 class="job-title"> ${title} </h1>
    <span class="location">Remote (EU)</span>
    <div class="description"><p>Build things at Acme, job ${String(id)}.</p><ul><li>TypeScript</li></ul></div>
  </body></html>`;
}

export const FEED_URL = 'https://careers.acme.example/jobs/feed/';

/** A thin RSS feed: titles and links only, so the jobs come from their pages. */
export const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Acme jobs</title>
  <item><title>Frontend Engineer</title><link>https://careers.acme.example/jobs/1</link></item>
  <item><title>Backend Engineer</title><link>/jobs/2</link></item>
</channel></rss>`;

export const PAGES: Record<string, string> = {
  [FEED_URL]: FEED_XML,
  [LIST_URL]: LIST_HTML,
  'https://careers.acme.example/jobs/1': jobHtml(1, 'Frontend Engineer'),
  'https://careers.acme.example/jobs/2': jobHtml(2, 'Backend Engineer'),
  'https://careers.acme.example/jobs/3': jobHtml(3, 'Designer'),
};

/** Serves `pages` as HTML, JSON or RSS by how the body starts; anything else is a 404. */
export function fakeFetch(pages: Record<string, string> = PAGES): FetchPage & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (url: string): Promise<Page> => {
    urls.push(url);
    const body = pages[url];
    const start = body?.trimStart() ?? '';
    const contentType =
      start.startsWith('{') || start.startsWith('[')
        ? 'application/json'
        : start.startsWith('<?xml')
          ? 'application/rss+xml'
          : 'text/html; charset=utf-8';
    return Promise.resolve({
      url,
      status: body === undefined ? 404 : 200,
      contentType,
      body: body ?? 'Not found',
    });
  };
  return Object.assign(fetch, { urls });
}

export const ACME_SITE: SiteMapping = {
  id: 'careers.acme.example',
  name: 'Acme',
  startUrl: 'https://careers.acme.example/',
  entryUrl: LIST_URL,
  list: {
    kind: 'links',
    selector: 'a.job-link',
    fields: {
      title: { jsonLd: 'title', transform: 'text' },
      company: { const: 'Acme' },
      location: { selector: '.location', transform: 'location' },
      postedAt: { jsonLd: 'datePosted', transform: 'date' },
      workMode: { jsonLd: 'jobLocationType', map: { TELECOMMUTE: 'remote' } },
      description: { selector: '.description', attr: 'html', transform: 'html' },
    },
  },
  mappedAt: '2026-10-21T12:00:00.000Z',
};

export type FieldInput = Partial<DraftField> & Pick<DraftField, 'target'>;
export type DraftInput = Partial<Omit<DraftMapping, 'fields'>> & { fields?: FieldInput[] };
export type StepInput = Partial<Omit<Step, 'mapping'>> &
  Pick<Step, 'note' | 'action'> & { mapping?: DraftMapping };

/** A draft field as the AI writes it: every property, `""` / `[]` when unused. */
export const field = (input: FieldInput): DraftField => ({
  selector: '',
  attr: '',
  jsonLd: '',
  path: '',
  const: '',
  transforms: [],
  map: [],
  default: '',
  ...input,
});

export const draft = ({ fields = [], ...input }: DraftInput): DraftMapping => ({
  name: 'Acme',
  entryUrl: LIST_URL,
  kind: 'links',
  linkSelector: '',
  linkPath: '',
  format: 'json',
  items: '',
  ...input,
  fields: fields.map(field),
});

export const step = (input: StepInput): Step => ({ url: '', reason: '', ...input });
