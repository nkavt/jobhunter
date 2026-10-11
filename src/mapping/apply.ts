import { JobSchema, type Job } from '../jobs/index.js';
import { formatIssues } from '../llm/index.js';
import type { FeedMapping, FieldRule } from './schema.js';
import { applyTransform } from './transforms.js';

export interface ItemError {
  /** Position in the feed's list of jobs. */
  index: number;
  message: string;
}

export interface MappingResult {
  jobs: Job[];
  errors: ItemError[];
  /** Entries skipped by `skipIf` (not jobs at all). */
  skipped: number;
}

/** Read a dot path; `''` is the value itself. XML text nodes with attributes are unwrapped. */
export function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path ? path.split('.') : []) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (current !== null && typeof current === 'object' && '#text' in current) {
    return (current as Record<string, unknown>)['#text'];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() ?? path;
  let node = target;
  for (const key of keys) {
    const next = node[key];
    if (next === null || typeof next !== 'object') node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[last] = value;
}

function resolve(item: unknown, rule: FieldRule): unknown {
  if (typeof rule === 'string') return getPath(item, rule);
  let value =
    'const' in rule && rule.const !== undefined
      ? rule.const
      : rule.from
        ? getPath(item, rule.from)
        : undefined;
  const transforms = rule.transform === undefined ? [] : [rule.transform].flat();
  for (const transform of transforms) value = applyTransform(value, transform);
  if (rule.map && value !== undefined) {
    value =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? rule.map[String(value)]
        : undefined;
  }
  return value ?? rule.default;
}

/** Drop a salary that ended up with only a currency/period and no amount or text. */
function tidy(draft: Record<string, unknown>): void {
  const salary = draft.salary as Record<string, unknown> | undefined;
  if (salary && salary.min === undefined && salary.max === undefined && salary.text === undefined) {
    delete draft.salary;
  }
  const location = (draft.location ?? {}) as Record<string, unknown>;
  draft.location = { ...location, regions: location.regions ?? [] };
  draft.description ??= '';
  draft.tags ??= [];
}

/** Turn a parsed feed into jobs. Items that don't make a valid job are reported, not fatal. */
export function applyMapping(feed: unknown, mapping: FeedMapping, source: string): MappingResult {
  const list = getPath(feed, mapping.items);
  const items: unknown[] = Array.isArray(list)
    ? list
    : list === undefined || list === null
      ? []
      : [list];

  const result: MappingResult = { jobs: [], errors: [], skipped: 0 };
  items.forEach((item, index) => {
    if (mapping.skipIf && getPath(item, mapping.skipIf.missing) === undefined) {
      result.skipped++;
      return;
    }
    const draft: Record<string, unknown> = { source };
    for (const [target, rule] of Object.entries(mapping.fields)) {
      const value = resolve(item, rule);
      if (value !== undefined) setPath(draft, target, value);
    }
    tidy(draft);

    const parsed = JobSchema.safeParse(draft);
    if (parsed.success) result.jobs.push(parsed.data);
    else result.errors.push({ index, message: formatIssues(parsed.error).join('; ') });
  });
  return result;
}
