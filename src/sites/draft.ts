import { z } from 'zod';
import { formatIssues } from '../llm/index.js';
import { FeedMappingSchema, MAPPING_TARGETS, TransformSchema } from '../mapping/index.js';
import { SiteListSchema, type SiteList } from './schema.js';

/*
 * What the AI writes. Flatter than the saved format (lists instead of records, no unions) so
 * every provider's structured output can produce it, including small local models.
 */

const DraftFieldSchema = z.object({
  target: z.enum(MAPPING_TARGETS),
  /** `links` sites: CSS selector on the job page. */
  selector: z.string().optional(),
  /** `links` sites, with `selector`: an attribute to read, or `html` for the inner HTML. */
  attr: z.string().optional(),
  /** `links` sites: dot path into the job page's JSON-LD JobPosting. */
  jsonLd: z.string().optional(),
  /** `feed` sites: dot path into each feed item. */
  path: z.string().optional(),
  const: z.string().optional(),
  transforms: z.array(TransformSchema).optional(),
  map: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  default: z.string().optional(),
});
export type DraftField = z.infer<typeof DraftFieldSchema>;

export const DraftMappingSchema = z.object({
  /** For the sheet's Channel column, e.g. the company or job board. */
  name: z.string().min(1),
  /** The job list to fetch on every hunt. */
  entryUrl: z.string(),
  kind: z.enum(['links', 'feed']),
  /** `links`: CSS selector for the job links on the list. */
  linkSelector: z.string().optional(),
  /** `feed`: the format of the entry address's response. */
  format: z.enum(['json', 'xml']).optional(),
  /** `feed`: dot path to the list of jobs; `''` when the response itself is the list. */
  items: z.string().optional(),
  fields: z.array(DraftFieldSchema),
});
export type DraftMapping = z.infer<typeof DraftMappingSchema>;

export const STEP_ACTIONS = ['fetch', 'test', 'finish', 'give_up'] as const;

export const StepSchema = z
  .object({
    /** One short sentence for the user: what this step does and why. */
    note: z.string().min(1),
    action: z.enum(STEP_ACTIONS),
    /** `fetch`: the address to look at. */
    url: z.string().optional(),
    /** `test` / `finish`: the mapping to try. */
    mapping: DraftMappingSchema.optional(),
    /** `give_up`: why the site can't be mapped. */
    reason: z.string().optional(),
  })
  .superRefine((step, ctx) => {
    if (step.action === 'fetch' && !step.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'required for "fetch"' });
    }
    if ((step.action === 'test' || step.action === 'finish') && !step.mapping) {
      ctx.addIssue({ code: 'custom', path: ['mapping'], message: `required for "${step.action}"` });
    }
  });
export type Step = z.infer<typeof StepSchema>;

const transformOf = (field: DraftField) =>
  field.transforms && field.transforms.length > 0
    ? { transform: field.transforms.length === 1 ? field.transforms[0] : field.transforms }
    : {};
const mapOf = (field: DraftField) =>
  field.map && field.map.length > 0
    ? { map: Object.fromEntries(field.map.map(({ from, to }) => [from, to])) }
    : {};
const defaultOf = (field: DraftField) =>
  field.default !== undefined ? { default: field.default } : {};

/** The saved form of a draft, or the problems to send back to the AI. */
export function draftToList(
  draft: DraftMapping,
): { list: SiteList; problems?: undefined } | { list?: undefined; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const field of draft.fields) {
    if (seen.has(field.target)) problems.push(`fields: "${field.target}" is listed twice`);
    seen.add(field.target);
  }

  let candidate: unknown;
  if (draft.kind === 'feed') {
    for (const field of draft.fields) {
      if ((field.path === undefined) === (field.const === undefined)) {
        problems.push(`fields.${field.target}: give exactly one of path and const`);
      }
    }
    const fields = Object.fromEntries(
      draft.fields.map((field) => [
        field.target,
        {
          ...(field.const !== undefined ? { const: field.const } : { from: field.path ?? '' }),
          ...transformOf(field),
          ...mapOf(field),
          ...defaultOf(field),
        },
      ]),
    );
    candidate = {
      kind: 'feed',
      mapping: { format: draft.format ?? 'json', items: draft.items ?? '', fields },
    };
    const mapping = FeedMappingSchema.safeParse((candidate as { mapping: unknown }).mapping);
    if (!mapping.success) problems.push(...formatIssues(mapping.error));
  } else {
    if (!draft.linkSelector) problems.push('linkSelector: required when kind is "links"');
    const fields: Record<string, unknown> = {};
    for (const field of draft.fields) {
      const sources = [field.selector, field.jsonLd, field.const].filter((s) => s !== undefined);
      if (sources.length !== 1) {
        problems.push(
          `fields.${field.target}: give exactly one of selector, jsonLd and const (got ${String(sources.length)})`,
        );
      }
      fields[field.target] = {
        ...(field.selector !== undefined ? { selector: field.selector } : {}),
        ...(field.attr !== undefined ? { attr: field.attr } : {}),
        ...(field.jsonLd !== undefined ? { jsonLd: field.jsonLd } : {}),
        ...(field.const !== undefined ? { const: field.const } : {}),
        ...transformOf(field),
        ...mapOf(field),
        ...defaultOf(field),
      };
    }
    candidate = { kind: 'links', selector: draft.linkSelector ?? '', fields };
  }

  const list = SiteListSchema.safeParse(candidate);
  if (!list.success) problems.push(...formatIssues(list.error));
  return problems.length > 0 || !list.success ? { problems } : { list: list.data };
}
