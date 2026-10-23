import { z } from 'zod';
import {
  CountryCodeSchema,
  CurrencyCodeSchema,
  EmploymentTypeSchema,
  SalaryPeriodSchema,
  SenioritySchema,
  WorkModeSchema,
} from '../schema/enums.js';
import { NotInitializedError } from './errors.js';
import { readJsonFile, writeJsonFile } from './fs.js';
import { profileFile } from './paths.js';

/** Used as a directory name, so keep it to a safe charset (no path traversal). */
export const ProfileNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,31}$/,
    'profile names use lowercase letters, digits, "-" and "_" (max 32 characters)',
  );

export const CvInfoSchema = z.object({
  sourcePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parsedAt: z.iso.datetime(),
});

/** Facts the AI extracts from `cv.md`; never asked as questions. */
export const DerivedSchema = z.object({
  roles: z.array(z.string().min(1)),
  seniority: SenioritySchema,
  yearsOfExperience: z.number().nonnegative(),
  tech: z.object({
    primary: z.array(z.string()),
    secondary: z.array(z.string()),
  }),
  domains: z.array(z.string()),
  languages: z.array(z.string()),
  location: z.string().optional(),
});

/** What the user wants next; answered in `init` / `jobhunter prefs`. */
export const PreferencesSchema = z.object({
  workModes: z.array(WorkModeSchema).min(1),
  remote: z
    .object({
      eligibleCountries: z.array(CountryCodeSchema),
      timezone: z
        .object({
          base: z.string().regex(/^UTC([+-]\d{1,2}(:[0-5]\d)?)?$/, 'expected e.g. "UTC+4"'),
          toleranceHours: z.number().min(0).max(12),
        })
        .optional(),
    })
    .optional(),
  onsite: z
    .object({
      cities: z.array(z.string().min(1)),
      /** `"no"`, `"yes"` (anywhere), or only to these countries. */
      relocation: z.union([z.literal('no'), z.literal('yes'), z.array(CountryCodeSchema).min(1)]),
    })
    .optional(),
  visaSponsorshipNeeded: z.boolean(),
  employmentTypes: z.array(EmploymentTypeSchema).min(1),
  minSalary: z
    .object({
      amount: z.number().positive(),
      currency: CurrencyCodeSchema,
      period: SalaryPeriodSchema,
    })
    .optional(),
  avoid: z
    .object({
      industries: z.array(z.string()).default([]),
      companies: z.array(z.string()).default([]),
    })
    .optional(),
  /** AI score (0–100) a job needs to land in "To apply" instead of "Skipped" (default: `DEFAULT_MIN_SCORE`). */
  minScore: z.number().int().min(0).max(100).optional(),
});

export const SheetLinkSchema = z.object({
  spreadsheetId: z.string().min(1),
  folderId: z.string().min(1).optional(),
  /** Header mapping for a linked existing sheet; `null` = default layout. */
  columns: z.record(z.string(), z.string()).nullable(),
  statusMap: z.record(z.string(), z.string()).nullable(),
});

/** The tracking sheet as a local .xlsx file instead of a Google Sheet. */
export const LocalSheetSchema = z.object({
  path: z.string().min(1),
});

/** Web searches for companies' own job boards (Greenhouse, Lever, Ashby, Workable). */
export const BoardSearchSchema = z.object({
  /** Searched on each board site instead of the CV's roles, e.g. `"react developer" remote`; `[]` = don't search. */
  queries: z.array(z.string().trim().min(1)),
});

/**
 * `profiles/<name>/profile.json`: who the user is and what they want. Filled in step by
 * step during `init`, so everything except identity is optional.
 */
export const ProfileSchema = z.object({
  version: z.literal(1),
  name: ProfileNameSchema,
  cv: CvInfoSchema.optional(),
  derived: DerivedSchema.optional(),
  preferences: PreferencesSchema.optional(),
  /** The Google tracking sheet. `null` = none; missing = not set up yet. */
  sheet: SheetLinkSchema.nullable().optional(),
  /** Set when the user tracks jobs in a local file; it wins over `sheet`. */
  localSheet: LocalSheetSchema.optional(),
  /** Missing = search by the CV's roles. Edited by hand in `profile.json`. */
  boardSearch: BoardSearchSchema.optional(),
});

export type CvInfo = z.infer<typeof CvInfoSchema>;
export type Derived = z.infer<typeof DerivedSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type SheetLink = z.infer<typeof SheetLinkSchema>;
export type LocalSheet = z.infer<typeof LocalSheetSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

export async function readProfile(name: string): Promise<Profile | undefined> {
  return readJsonFile(profileFile(ProfileNameSchema.parse(name)), ProfileSchema);
}

export async function loadProfile(name: string): Promise<Profile> {
  const profile = await readProfile(name);
  if (!profile) {
    throw new NotInitializedError(
      `Profile "${name}" does not exist. Run \`jobhunter init\` first.`,
    );
  }
  return profile;
}

export async function saveProfile(profile: Profile): Promise<void> {
  const valid = ProfileSchema.parse(profile);
  await writeJsonFile(profileFile(valid.name), valid);
}
