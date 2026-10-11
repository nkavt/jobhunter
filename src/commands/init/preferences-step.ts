import type { Preferences } from '../../config/index.js';
import type { PreferenceSuggestions } from '../../profile/facts.js';
import {
  asValidation,
  formatSalary,
  formatTimezone,
  parseCountryCodes,
  parseList,
  parseSalary,
  parseTimezone,
  valueOf,
} from '../../profile/preferences.js';
import type { EmploymentType, WorkMode } from '../../schema/enums.js';
import { dim, type Ui } from '../../ui/index.js';

export interface PreferenceDefaults {
  /** Answers saved earlier; they win over suggestions. */
  saved?: Preferences;
  /** What the AI read from the CV. */
  suggestions: PreferenceSuggestions;
}

const optional = (text: string) => `${text} ${dim('(Enter to skip)')}`;

/** Ask what a CV can't tell us. Every question is pre-filled from saved answers or the CV. */
export async function askPreferences(ui: Ui, defaults: PreferenceDefaults): Promise<Preferences> {
  const { saved, suggestions } = defaults;

  const workModes = await ui.checkbox<WorkMode>({
    message: 'Work mode',
    choices: [
      { name: 'Remote', value: 'remote' },
      { name: 'Hybrid', value: 'hybrid' },
      { name: 'Onsite', value: 'onsite' },
    ],
    default: saved?.workModes ?? suggestions.workModes ?? ['remote'],
    required: true,
  });

  let remote: Preferences['remote'];
  if (workModes.includes('remote')) {
    const countries = await ui.input({
      message: 'Countries you can legally work from (2-letter codes, e.g. GE, DE)',
      default: saved?.remote?.eligibleCountries.join(', ') ?? suggestions.countryCode ?? '',
      validate: asValidation(parseCountryCodes),
    });
    const savedTimezone = saved?.remote?.timezone;
    const timezone = await ui.input({
      message: optional('Your timezone and how many hours you can shift (e.g. UTC+4 ±3h)'),
      ...(savedTimezone ? { default: formatTimezone(savedTimezone) } : {}),
      validate: asValidation(parseTimezone),
    });
    const parsedTimezone = valueOf(parseTimezone(timezone));
    remote = {
      eligibleCountries: valueOf(parseCountryCodes(countries)),
      ...(parsedTimezone ? { timezone: parsedTimezone } : {}),
    };
  }

  let onsite: Preferences['onsite'];
  if (workModes.includes('hybrid') || workModes.includes('onsite')) {
    const cities = await ui.input({
      message: 'Cities you would work in (comma-separated)',
      default: saved?.onsite?.cities.join(', ') ?? suggestions.city ?? '',
      validate: (text) => (parseList(text).length > 0 ? true : 'Enter at least one city'),
    });
    const savedRelocation = saved?.onsite?.relocation;
    const relocation = await ui.select<'no' | 'yes' | 'some'>({
      message: 'Open to relocating?',
      choices: [
        { name: 'No', value: 'no' },
        { name: 'Yes, anywhere', value: 'yes' },
        { name: 'Only to certain countries', value: 'some' },
      ],
      default: Array.isArray(savedRelocation) ? 'some' : (savedRelocation ?? 'no'),
    });
    onsite = {
      cities: parseList(cities),
      relocation:
        relocation === 'some'
          ? valueOf(
              parseCountryCodes(
                await ui.input({
                  message: 'Which countries? (2-letter codes)',
                  default: Array.isArray(savedRelocation) ? savedRelocation.join(', ') : '',
                  validate: asValidation(parseCountryCodes),
                }),
              ),
            )
          : relocation,
    };
  }

  const visaSponsorshipNeeded = await ui.confirm({
    message: 'Do you need visa sponsorship?',
    default: saved?.visaSponsorshipNeeded ?? false,
  });

  const employmentTypes = await ui.checkbox<EmploymentType>({
    message: 'Employment type',
    choices: [
      { name: 'Full-time', value: 'full_time' },
      { name: 'Part-time', value: 'part_time' },
      { name: 'Contract', value: 'contract' },
      { name: 'Freelance', value: 'freelance' },
      { name: 'Internship', value: 'internship' },
    ],
    default: saved?.employmentTypes ?? suggestions.employmentTypes ?? ['full_time'],
    required: true,
  });

  const salary = await ui.input({
    message: optional('Minimum salary (e.g. 60000 EUR/year, 5000 USD/month)'),
    ...(saved?.minSalary ? { default: formatSalary(saved.minSalary) } : {}),
    validate: asValidation(parseSalary),
  });
  const minSalary = valueOf(parseSalary(salary));

  const industries = parseList(
    await ui.input({
      message: optional('Industries to avoid (comma-separated, e.g. gambling, crypto)'),
      ...(saved?.avoid?.industries.length ? { default: saved.avoid.industries.join(', ') } : {}),
    }),
  );
  const companies = parseList(
    await ui.input({
      message: optional('Companies to avoid (comma-separated)'),
      ...(saved?.avoid?.companies.length ? { default: saved.avoid.companies.join(', ') } : {}),
    }),
  );

  return {
    workModes,
    ...(remote ? { remote } : {}),
    ...(onsite ? { onsite } : {}),
    visaSponsorshipNeeded,
    employmentTypes,
    ...(minSalary ? { minSalary } : {}),
    ...(industries.length || companies.length ? { avoid: { industries, companies } } : {}),
    ...(saved?.minScore !== undefined ? { minScore: saved.minScore } : {}),
  };
}
