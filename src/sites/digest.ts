import { NodeType, parse, type HTMLElement, type Node } from 'node-html-parser';
import { parseFeed } from '../mapping/index.js';
import { findJobPosting } from './extract.js';
import { pageFormat, type Page } from './page.js';

/** Rough size limits, in characters, so one page stays a few thousand tokens. */
const LIMITS = {
  skeleton: 14_000,
  links: 150,
  linkText: 80,
  text: 60,
  forms: 6,
  options: 25,
  scripts: 20,
  apiHints: 40,
  jsonLd: 3_000,
  outline: 8_000,
  sample: 3_000,
} as const;

/** Never useful for finding jobs, and often huge. */
const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'template', 'head', 'iframe']);
/** Siblings shown before "… N more like this". */
const REPEATS_SHOWN = 2;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A page as the AI sees it: what's on it and where to look next, in a few thousand tokens. */
export function digestPage(page: Page): string {
  const header = [
    `URL: ${page.url}`,
    `HTTP ${String(page.status)} · ${page.contentType || 'no content type'} · ${String(page.body.length)} characters`,
  ];
  const format = pageFormat(page);
  const body =
    format === 'html'
      ? digestHtml(page)
      : digestData(page.body, format === 'json' ? 'json' : 'xml');
  return [...header, '', body].join('\n');
}

function digestData(body: string, format: 'json' | 'xml'): string {
  let data: unknown;
  try {
    data = parseFeed(body, format);
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n\n${clip(body, LIMITS.sample)}`;
  }
  return [
    `${format.toUpperCase()} outline (dot paths; for lists, the first entry):`,
    clip(outline(data).join('\n'), LIMITS.outline),
    '',
    'Start of the body:',
    clip(body, LIMITS.sample),
  ].join('\n');
}

/** Dot paths with their type and a sample value. */
export function outline(value: unknown, path = '', lines: string[] = []): string[] {
  const label = path || '(root)';
  if (Array.isArray(value)) {
    lines.push(`${label}: list of ${String(value.length)}`);
    if (value.length > 0) outline(value[0], path ? `${path}.0` : '0', lines);
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) lines.push(`${label}: {}`);
    for (const key of keys) {
      outline((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, lines);
    }
  } else {
    const sample =
      typeof value === 'string' ? JSON.stringify(clip(oneLine(value), 80)) : String(value);
    lines.push(`${label}: ${sample}`);
  }
  return lines;
}

function digestHtml(page: Page): string {
  const root = parse(page.body);
  const sections: string[] = [];
  const title = oneLine(root.querySelector('title')?.text ?? '');
  if (title) sections.push(`Title: ${title}`);

  const posting = findJobPosting(root);
  if (posting) {
    sections.push(
      `JSON-LD JobPosting (use with jsonLd paths):\n${clip(JSON.stringify(posting, null, 1), LIMITS.jsonLd)}`,
    );
  }

  const forms = describeForms(root, page.url);
  if (forms) sections.push(`Forms (filters often become query parameters):\n${forms}`);

  const frames = root
    .querySelectorAll('iframe[src]')
    .map((frame) => absolute(frame.getAttribute('src') ?? '', page.url))
    .filter(Boolean);
  if (frames.length > 0) sections.push(`Embedded frames:\n${frames.join('\n')}`);

  const hints = apiHints(root, page.url);
  if (hints) sections.push(hints);

  sections.push(`Links (text → address):\n${describeLinks(root, page.url)}`);
  sections.push(
    `Page structure (tag#id.classes "text"; repeated siblings collapsed):\n${clip(skeleton(root.querySelector('body') ?? root).join('\n'), LIMITS.skeleton)}`,
  );
  return sections.join('\n\n');
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

function describeLinks(root: HTMLElement, base: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const link of root.querySelectorAll('a[href]')) {
    const href = absolute(link.getAttribute('href') ?? '', base);
    if (!href.startsWith('http') || seen.has(href)) continue;
    seen.add(href);
    lines.push(`${clip(oneLine(link.text), LIMITS.linkText) || '(no text)'} → ${href}`);
  }
  const shown = lines.slice(0, LIMITS.links);
  if (lines.length > shown.length) {
    shown.push(`… ${String(lines.length - shown.length)} more links`);
  }
  return shown.join('\n') || '(none)';
}

function describeForms(root: HTMLElement, base: string): string {
  return root
    .querySelectorAll('form')
    .slice(0, LIMITS.forms)
    .map((form) => {
      const action = absolute(form.getAttribute('action') ?? '', base) || base;
      const method = (form.getAttribute('method') ?? 'get').toUpperCase();
      const fields = form.querySelectorAll('input[name], select[name]').map((field) => {
        const name = field.getAttribute('name') ?? '';
        if (field.tagName === 'SELECT') {
          const options = field
            .querySelectorAll('option')
            .slice(0, LIMITS.options)
            .map((option) => `${option.getAttribute('value') ?? ''}=${oneLine(option.text)}`);
          return `  ${name}: one of ${options.join(', ')}`;
        }
        const type = field.getAttribute('type') ?? 'text';
        const value = field.getAttribute('value');
        return `  ${name} (${type})${value ? ` = ${value}` : ''}`;
      });
      return [`${method} ${action}`, ...fields].join('\n');
    })
    .join('\n');
}

/** Where a page built in the browser loads its jobs from: endpoints named in its scripts. */
function apiHints(root: HTMLElement, base: string): string {
  const scripts = root.querySelectorAll('script');
  const sources = scripts
    .map((script) => script.getAttribute('src'))
    .filter((src): src is string => Boolean(src))
    .map((src) => absolute(src, base))
    .slice(0, LIMITS.scripts);

  const endpoints = new Set<string>();
  const state: string[] = [];
  for (const script of scripts) {
    const text = script.rawText;
    if (!text || script.getAttribute('type') === 'application/ld+json') continue;
    const id = script.getAttribute('id');
    if (id === '__NEXT_DATA__' || id === '__NUXT_DATA__') {
      state.push(`<script id="${id}"> with ${String(text.length)} characters of JSON`);
    }
    const assigned = /window\.(__[A-Z_]+__)\s*=/.exec(text);
    if (assigned?.[1]) state.push(`window.${assigned[1]} set in an inline script`);
    for (const match of text.matchAll(/["'`]((?:https?:\/\/|\/)[^"'`\s]{3,200})["'`]/g)) {
      const value = match[1] ?? '';
      if (/api|graphql|jobs?\b|positions|vacanc|openings|careers|postings|\.json/i.test(value)) {
        endpoints.add(value);
      }
      if (endpoints.size >= LIMITS.apiHints) break;
    }
  }

  const parts: string[] = [];
  if (state.length > 0) parts.push(`Data embedded for the page's scripts:\n${state.join('\n')}`);
  if (endpoints.size > 0) {
    parts.push(`Addresses named in inline scripts:\n${[...endpoints].join('\n')}`);
  }
  if (sources.length > 0) parts.push(`Script files:\n${sources.join('\n')}`);
  return parts.join('\n\n');
}

function signature(element: HTMLElement): string {
  const id = element.id ? `#${element.id}` : '';
  const classes = element.classList.value.map((name) => `.${name}`).join('');
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

const isElement = (node: Node): node is HTMLElement => node.nodeType === NodeType.ELEMENT_NODE;

/** An indented outline of the elements, so the AI can write CSS selectors for them. */
function skeleton(element: HTMLElement, depth = 0, lines: string[] = []): string[] {
  const children = element.childNodes.filter(
    (node): node is HTMLElement => isElement(node) && !SKIPPED_TAGS.has(node.tagName.toLowerCase()),
  );
  let previous = '';
  let repeats = 0;
  const flush = () => {
    if (repeats > REPEATS_SHOWN) {
      lines.push(`${'  '.repeat(depth)}… ${String(repeats - REPEATS_SHOWN)} more like this`);
    }
  };

  for (const child of children) {
    const sig = signature(child);
    repeats = sig === previous ? repeats + 1 : (flush(), 1);
    previous = sig;
    if (repeats > REPEATS_SHOWN) continue;

    const own = oneLine(
      child.childNodes
        .filter((node) => node.nodeType === NodeType.TEXT_NODE)
        .map((node) => node.text)
        .join(' '),
    );
    const href = child.tagName === 'A' ? ` href=${child.getAttribute('href') ?? ''}` : '';
    const text = own ? ` "${clip(own, LIMITS.text)}"` : '';
    lines.push(`${'  '.repeat(depth)}${sig}${href}${text}`);
    skeleton(child, depth + 1, lines);
  }
  flush();
  return lines;
}
