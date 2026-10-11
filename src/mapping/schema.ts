import { z } from 'zod';

/** Job fields a mapping can fill (dotted for nested ones). `source` is set by the engine. */
export const MAPPING_TARGETS = [
  'sourceId',
  'url',
  'title',
  'company',
  'location',
  'location.text',
  'location.worldwide',
  'location.regions',
  'workMode',
  'employmentType',
  'salary',
  'salary.min',
  'salary.max',
  'salary.currency',
  'salary.period',
  'salary.text',
  'postedAt',
  'description',
  'tags',
] as const;
export type MappingTarget = (typeof MAPPING_TARGETS)[number];

export const TRANSFORMS = [
  'string',
  'text',
  'number',
  'positive',
  'html',
  'date',
  'location',
  'salaryText',
  'list',
  'lowercase',
  'periodFromAmount',
] as const;

/** A named transform, or `before:<sep>` / `after:<sep>` to split "Company: Title"-style values. */
export const TransformSchema = z.union([
  z.enum(TRANSFORMS),
  z.string().regex(/^(before|after):.+$/, 'expected a transform name or before:/after:<separator>'),
]);
export type Transform = z.infer<typeof TransformSchema>;

export const FieldRuleSchema = z.union([
  /** Shorthand: a dot path into the item, copied as-is. */
  z.string(),
  z.strictObject({
    /** Dot path into the item. */
    from: z.string().optional(),
    /** A fixed value instead of reading the item. */
    const: z.unknown().optional(),
    /** Applied in order. */
    transform: z.union([TransformSchema, z.array(TransformSchema)]).optional(),
    /** Translate values (after transforms); unmapped values are dropped. */
    map: z.record(z.string(), z.string()).optional(),
    /** Used when the value ends up missing. */
    default: z.unknown().optional(),
  }),
]);
export type FieldRule = z.infer<typeof FieldRuleSchema>;

/**
 * How to turn one feed into jobs. Plain JSON, so built-in mappings (constants) and mappings
 * saved in the config (written by the user or the AI) share one format.
 */
export const FeedMappingSchema = z.strictObject({
  format: z.enum(['json', 'xml']),
  /** Dot path to the list of jobs; `''` means the feed itself is the list. */
  items: z.string(),
  /** Skip entries that aren't jobs, e.g. a notice at the start of the list. */
  skipIf: z.strictObject({ missing: z.string() }).optional(),
  fields: z.partialRecord(z.enum(MAPPING_TARGETS), FieldRuleSchema),
});
export type FeedMapping = z.infer<typeof FeedMappingSchema>;
