import { z } from 'zod';

// Shared by profile preferences (jh-2/jh-7) and the canonical job format (jh-9).

export const WorkModeSchema = z.enum(['remote', 'hybrid', 'onsite']);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const EmploymentTypeSchema = z.enum([
  'full_time',
  'part_time',
  'contract',
  'freelance',
  'internship',
]);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

export const SenioritySchema = z.enum(['junior', 'mid', 'senior', 'lead', 'principal']);
export type Seniority = z.infer<typeof SenioritySchema>;

export const SalaryPeriodSchema = z.enum(['year', 'month', 'hour']);
export type SalaryPeriod = z.infer<typeof SalaryPeriodSchema>;

/** ISO 3166-1 alpha-2, e.g. `GE`. */
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'expected a 2-letter country code');

/** ISO 4217, e.g. `EUR`. */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'expected a 3-letter currency code');
