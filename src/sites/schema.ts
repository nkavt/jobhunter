import { z } from 'zod';
import { FeedMappingSchema, MAPPING_TARGETS, TransformSchema } from '../mapping/index.js';

/**
 * Where one job field comes from on a job's own page. Exactly one of `selector`, `jsonLd` and
 * `const` says where; the rest work like a feed mapping's field rule.
 */
export const PageRuleSchema = z.strictObject({
  /** CSS selector; the first match is read. */
  selector: z.string().min(1).optional(),
  /** With `selector`: read this attribute instead of the text; `html` reads the inner HTML. */
  attr: z.string().min(1).optional(),
  /** Dot path into the page's schema.org JobPosting (JSON-LD), e.g. `hiringOrganization.name`. */
  jsonLd: z.string().min(1).optional(),
  /** A fixed value, e.g. the company of a single company's careers site. */
  const: z.string().optional(),
  transform: z.union([TransformSchema, z.array(TransformSchema)]).optional(),
  map: z.record(z.string(), z.string()).optional(),
  default: z.string().optional(),
});
export type PageRule = z.infer<typeof PageRuleSchema>;

/** Job links from a feed whose items are too thin to be jobs on their own (often RSS). */
export const LinkFeedSchema = z.strictObject({
  format: z.enum(['json', 'xml']),
  /** Dot path to the list of items; `''` means the feed itself is the list. */
  items: z.string(),
  /** Dot path to the job page's address inside one item, e.g. `link`. */
  link: z.string().min(1),
});
export type LinkFeed = z.infer<typeof LinkFeedSchema>;

/** The listing links to one page per job; each job is read from its page. */
const LinksListSchema = z
  .strictObject({
    kind: z.literal('links'),
    /** CSS selector for the `<a>` elements that open a job, on an HTML list. */
    selector: z.string().min(1).optional(),
    /** Or: the list is a feed, and each item links to a job page. */
    feed: LinkFeedSchema.optional(),
    /** Job fields on each job page. `url` and `sourceId` default to the page's address. */
    fields: z.partialRecord(z.enum(MAPPING_TARGETS), PageRuleSchema),
  })
  .refine((list) => (list.selector === undefined) !== (list.feed === undefined), {
    message: 'give either a selector or a feed for the job links',
  });

/** The listing is a JSON or XML feed with whole jobs, often the API behind a site's own page. */
const FeedListSchema = z.strictObject({
  kind: z.literal('feed'),
  mapping: FeedMappingSchema,
});

export const SiteListSchema = z.discriminatedUnion('kind', [LinksListSchema, FeedListSchema]);
export type SiteList = z.infer<typeof SiteListSchema>;

/**
 * A job site mapped by `jobhunter map`: what to fetch on every hunt and how to read it, so the AI
 * is only needed once per site.
 */
export const SiteMappingSchema = z.strictObject({
  /** Stable slug, stored on every job (`job.source`). */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** Shown in the sheet's Channel column. */
  name: z.string().min(1),
  /** The address given to `map`. */
  startUrl: z.url(),
  /** Fetched on every hunt: the job list, filtered for the user's roles where the site allows. */
  entryUrl: z.url(),
  list: SiteListSchema,
  mappedAt: z.iso.datetime(),
  /** The model that mapped it. */
  mappedBy: z.string().optional(),
});
export type SiteMapping = z.infer<typeof SiteMappingSchema>;

export const SitesFileSchema = z.strictObject({
  version: z.literal(1),
  sites: z.array(SiteMappingSchema),
});
export type SitesFile = z.infer<typeof SitesFileSchema>;
