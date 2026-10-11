import { z } from 'zod';
import { DerivedSchema, type Derived } from '../config/index.js';
import type { LLMAdapter, Usage } from '../llm/index.js';
import { renderSystemPrompt, renderUserPrompt } from '../prompts/index.js';
import { CountryCodeSchema, EmploymentTypeSchema, WorkModeSchema } from '../schema/enums.js';

/** Defaults the AI suggests for the preference questions; never saved as-is. */
export const PreferenceSuggestionsSchema = z.object({
  countryCode: CountryCodeSchema.optional(),
  city: z.string().min(1).optional(),
  workModes: z.array(WorkModeSchema).optional(),
  employmentTypes: z.array(EmploymentTypeSchema).optional(),
});
export type PreferenceSuggestions = z.infer<typeof PreferenceSuggestionsSchema>;

const CvFactsSchema = DerivedSchema.extend({ suggestions: PreferenceSuggestionsSchema });

export interface CvFacts {
  derived: Derived;
  suggestions: PreferenceSuggestions;
  usage: Usage;
}

/** Read roles, seniority, stack… from `cv.md`, plus suggested preference defaults. */
export async function extractCvFacts(cvMarkdown: string, llm: LLMAdapter): Promise<CvFacts> {
  const { data, usage } = await llm.generateJSON({
    system: renderSystemPrompt('extract-cv-facts'),
    prompt: renderUserPrompt('extract-cv-facts', { cv: cvMarkdown }),
    schema: CvFactsSchema,
    schemaName: 'cv_facts',
  });
  const { suggestions, ...derived } = data;
  return { derived, suggestions, usage };
}
