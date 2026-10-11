/** What a model would return for `extract-cv-facts` on a made-up CV. */
export const FACTS_ANSWER = {
  roles: ['Senior Frontend Engineer', 'Full-Stack Engineer'],
  seniority: 'senior',
  yearsOfExperience: 8,
  tech: { primary: ['TypeScript', 'React'], secondary: ['AWS'] },
  domains: ['fintech'],
  languages: ['English', 'Georgian'],
  location: 'Tbilisi, Georgia',
  suggestions: { countryCode: 'GE', city: 'Tbilisi', workModes: ['remote'] },
};

/** `FACTS_ANSWER` without the suggestions: what ends up in `profile.json → derived`. */
export const DERIVED_ANSWER = {
  roles: FACTS_ANSWER.roles,
  seniority: 'senior' as const,
  yearsOfExperience: FACTS_ANSWER.yearsOfExperience,
  tech: FACTS_ANSWER.tech,
  domains: FACTS_ANSWER.domains,
  languages: FACTS_ANSWER.languages,
  location: FACTS_ANSWER.location,
};
