import { z } from 'zod';
import { formatIssues } from '../llm/index.js';
import { FeedMappingSchema, MAPPING_TARGETS, TransformSchema } from '../mapping/index.js';
import { SiteListSchema, type SiteList } from './schema.js';

/*
 * What the AI writes. Flatter than the saved format (lists instead of records, no unions) so
 * every provider's structured output can produce it, including small local models.
 *
 * Every property is required, with `""` or `[]` for "not used": each optional property roughly
 * doubles the grammar Claude's structured output compiles, and optional properties nested in a
 * list of fields made the schema "too complex for compilation".
 */

const DraftFieldSchema = z.object({
  target: z.enum(MAPPING_TARGETS),
  /** `links` sites: CSS selector on the job page. */
  selector: z.string(),
  /** `links` sites, with `selector`: an attribute to read, or `html` for the inner HTML. */
  attr: z.string(),
  /** `links` sites: dot path into the job page's JSON-LD JobPosting. */
  jsonLd: z.string(),
  /** `feed` sites: dot path into each feed item. */
  path: z.string(),
  const: z.string(),
  /** Transform names, checked in code: a union with a pattern is costly to compile. */
  transforms: z.array(z.string()),
  map: z.array(z.object({ from: z.string(), to: z.string() })),
  default: z.string(),
});
export type DraftField = z.infer<typeof DraftFieldSchema>;

export const DraftMappingSchema = z.object({
  /** For the sheet's Channel column, e.g. the company or job board. */
  name: z.string().min(1),
  /** The job list to fetch on every hunt. */
  entryUrl: z.string(),
  kind: z.enum(['links', 'feed']),
  /** `links` on an HTML list: CSS selector for the job links. */
  linkSelector: z.string(),
  /** `links` on a feed: dot path to the job page's address inside one item. */
  linkPath: z.string(),
  /** `feed`, or `links` on a feed: the format of the entry address's response. */
  format: z.enum(['json', 'xml']),
  /** `feed`, or `links` on a feed: dot path to the list; `""` when the response is the list. */
  items: z.string(),
  fields: z.array(DraftFieldSchema),
});
export type DraftMapping = z.infer<typeof DraftMappingSchema>;

export const STEP_ACTIONS = ['fetch', 'test', 'finish', 'give_up'] as const;

export const StepSchema = z
  .object({
    /** One short sentence for the user: what this step does and why. */
    note: z.string().min(1),
    action: z.enum(STEP_ACTIONS),
    /** `fetch`: the address to look at; `""` otherwise. */
    url: z.string(),
    /** `test` / `finish`: the mapping to try. The one optional property. */
    mapping: DraftMappingSchema.optional(),
    /** `give_up`: why the site can't be mapped; `""` otherwise. */
    reason: z.string(),
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

/** `""` means "not used". */
const given = (value: string): string | undefined => (value === '' ? undefined : value);

const transformOf = (field: DraftField) =>
  field.transforms.length > 0
    ? { transform: field.transforms.length === 1 ? field.transforms[0] : field.transforms }
    : {};
const mapOf = (field: DraftField) =>
  field.map.length > 0
    ? { map: Object.fromEntries(field.map.map(({ from, to }) => [from, to])) }
    : {};
const defaultOf = (field: DraftField) =>
  given(field.default) !== undefined ? { default: field.default } : {};

/** The saved form of a draft, or the problems to send back to the AI. */
export function draftToList(
  draft: DraftMapping,
): { list: SiteList; problems?: undefined } | { list?: undefined; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const field of draft.fields) {
    if (seen.has(field.target)) problems.push(`fields: "${field.target}" is listed twice`);
    seen.add(field.target);
    for (const transform of field.transforms) {
      if (!TransformSchema.safeParse(transform).success) {
        problems.push(
          `fields.${field.target}.transforms: "${transform}" is not a transform name or before:/after:<separator>`,
        );
      }
    }
  }

  let candidate: unknown;
  if (draft.kind === 'feed') {
    for (const field of draft.fields) {
      if ((given(field.path) === undefined) === (given(field.const) === undefined)) {
        problems.push(`fields.${field.target}: give exactly one of path and const`);
      }
    }
    const fields = Object.fromEntries(
      draft.fields.map((field) => [
        field.target,
        {
          ...(given(field.const) !== undefined ? { const: field.const } : { from: field.path }),
          ...transformOf(field),
          ...mapOf(field),
          ...defaultOf(field),
        },
      ]),
    );
    candidate = {
      kind: 'feed',
      mapping: { format: draft.format, items: draft.items, fields },
    };
    const mapping = FeedMappingSchema.safeParse((candidate as { mapping: unknown }).mapping);
    if (!mapping.success) problems.push(...formatIssues(mapping.error));
  } else {
    const linkSelector = given(draft.linkSelector);
    const linkPath = given(draft.linkPath);
    if ((linkSelector === undefined) === (linkPath === undefined)) {
      problems.push(
        'linkSelector / linkPath: give one when kind is "links": linkSelector for an HTML list, linkPath for a feed',
      );
    }
    const fields: Record<string, unknown> = {};
    for (const field of draft.fields) {
      const selector = given(field.selector);
      const jsonLd = given(field.jsonLd);
      const constant = given(field.const);
      const sources = [selector, jsonLd, constant].filter((s) => s !== undefined);
      if (sources.length !== 1) {
        problems.push(
          `fields.${field.target}: give exactly one of selector, jsonLd and const (got ${String(sources.length)})`,
        );
      }
      fields[field.target] = {
        ...(selector !== undefined ? { selector } : {}),
        ...(given(field.attr) !== undefined ? { attr: field.attr } : {}),
        ...(jsonLd !== undefined ? { jsonLd } : {}),
        ...(constant !== undefined ? { const: constant } : {}),
        ...transformOf(field),
        ...mapOf(field),
        ...defaultOf(field),
      };
    }
    candidate = {
      kind: 'links',
      ...(linkPath !== undefined
        ? { feed: { format: draft.format, items: draft.items, link: linkPath } }
        : { selector: linkSelector ?? '' }),
      fields,
    };
  }

  const list = SiteListSchema.safeParse(candidate);
  if (!list.success) problems.push(...formatIssues(list.error));
  return problems.length > 0 || !list.success ? { problems } : { list: list.data };
}
