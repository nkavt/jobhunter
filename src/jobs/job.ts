import { z } from 'zod';
import {
  CurrencyCodeSchema,
  EmploymentTypeSchema,
  SalaryPeriodSchema,
  WorkModeSchema,
} from '../schema/enums.js';

/**
 * Our job format: every source is converted into this, and the filters, the AI check and the
 * sheet all read it. Fields a source doesn't provide are left out rather than guessed.
 */
export const JobSchema = z.object({
  /** Source slug, e.g. `remotive`. */
  source: z.string().min(1),
  /** The job's ID within its source (or its URL when the source has no ID). */
  sourceId: z.string().min(1),
  /** The job's page on the source; linking back is required by the boards' terms. */
  url: z.url(),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.object({
    /** What the source said, e.g. "USA, Canada" or "Anywhere in the World". */
    text: z.string().optional(),
    /** The job explicitly accepts candidates from anywhere. */
    worldwide: z.boolean().optional(),
    /** Countries / regions the job is limited to, as written by the source. */
    regions: z.array(z.string()),
  }),
  workMode: WorkModeSchema.optional(),
  employmentType: EmploymentTypeSchema.optional(),
  salary: z
    .object({
      min: z.number().positive().optional(),
      max: z.number().positive().optional(),
      currency: CurrencyCodeSchema.optional(),
      period: SalaryPeriodSchema.optional(),
      /** The original text, kept when the source gave one. */
      text: z.string().optional(),
    })
    .optional(),
  postedAt: z.iso.datetime({ offset: true }).optional(),
  /** Plain text (HTML removed). */
  description: z.string(),
  tags: z.array(z.string()),
});
export type Job = z.infer<typeof JobSchema>;
