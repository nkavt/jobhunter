/**
 * Just enough geography to read location limits like "USA, Canada" or "North America Only".
 * Unknown names are never treated as excluding anyone: the job passes to the AI instead.
 */

/** Region names (lowercase) and aliases. */
const REGIONS: Record<string, string[]> = {
  europe: [
    'europe',
    'european',
    'eu',
    'eea',
    'european union',
    'eastern europe',
    'western europe',
    'cee',
  ],
  emea: ['emea'],
  americas: ['americas'],
  'north america': ['north america', 'northern america', 'na'],
  latam: ['latam', 'latin america', 'south america', 'central america'],
  apac: ['apac', 'asia pacific', 'asia-pacific', 'asia'],
  'middle east': ['middle east', 'mena'],
  africa: ['africa'],
  oceania: ['oceania'],
};

/** Countries by ISO code: names/aliases, and the regions a candidate there belongs to. */
const COUNTRIES: Record<string, { names: string[]; regions: string[] }> = {
  US: {
    names: ['usa', 'us', 'united states', 'united states of america', 'america'],
    regions: ['north america', 'americas'],
  },
  CA: { names: ['canada'], regions: ['north america', 'americas'] },
  MX: { names: ['mexico'], regions: ['north america', 'latam', 'americas'] },
  BR: { names: ['brazil'], regions: ['latam', 'americas'] },
  AR: { names: ['argentina'], regions: ['latam', 'americas'] },
  CO: { names: ['colombia'], regions: ['latam', 'americas'] },
  CL: { names: ['chile'], regions: ['latam', 'americas'] },
  PE: { names: ['peru'], regions: ['latam', 'americas'] },
  GB: {
    names: ['uk', 'united kingdom', 'great britain', 'england', 'scotland', 'wales'],
    regions: ['europe', 'emea'],
  },
  IE: { names: ['ireland'], regions: ['europe', 'emea'] },
  DE: { names: ['germany', 'deutschland'], regions: ['europe', 'emea'] },
  FR: { names: ['france'], regions: ['europe', 'emea'] },
  ES: { names: ['spain'], regions: ['europe', 'emea'] },
  PT: { names: ['portugal'], regions: ['europe', 'emea'] },
  IT: { names: ['italy'], regions: ['europe', 'emea'] },
  NL: { names: ['netherlands', 'holland'], regions: ['europe', 'emea'] },
  BE: { names: ['belgium'], regions: ['europe', 'emea'] },
  CH: { names: ['switzerland'], regions: ['europe', 'emea'] },
  AT: { names: ['austria'], regions: ['europe', 'emea'] },
  PL: { names: ['poland'], regions: ['europe', 'emea'] },
  CZ: { names: ['czechia', 'czech republic'], regions: ['europe', 'emea'] },
  RO: { names: ['romania'], regions: ['europe', 'emea'] },
  BG: { names: ['bulgaria'], regions: ['europe', 'emea'] },
  GR: { names: ['greece'], regions: ['europe', 'emea'] },
  SE: { names: ['sweden'], regions: ['europe', 'emea'] },
  NO: { names: ['norway'], regions: ['europe', 'emea'] },
  DK: { names: ['denmark'], regions: ['europe', 'emea'] },
  FI: { names: ['finland'], regions: ['europe', 'emea'] },
  IS: { names: ['iceland'], regions: ['europe', 'emea'] },
  EE: { names: ['estonia'], regions: ['europe', 'emea'] },
  LV: { names: ['latvia'], regions: ['europe', 'emea'] },
  LT: { names: ['lithuania'], regions: ['europe', 'emea'] },
  UA: { names: ['ukraine'], regions: ['europe', 'emea'] },
  RS: { names: ['serbia'], regions: ['europe', 'emea'] },
  TR: { names: ['turkey', 'türkiye', 'turkiye'], regions: ['europe', 'emea', 'middle east'] },
  // Transcontinental; counted as Europe so "Europe" roles reach the AI rather than being dropped.
  GE: { names: ['georgia', 'sakartvelo'], regions: ['europe', 'emea'] },
  AM: { names: ['armenia'], regions: ['europe', 'emea'] },
  AZ: { names: ['azerbaijan'], regions: ['europe', 'emea'] },
  IL: { names: ['israel'], regions: ['emea', 'middle east'] },
  AE: { names: ['uae', 'united arab emirates'], regions: ['emea', 'middle east'] },
  EG: { names: ['egypt'], regions: ['emea', 'africa', 'middle east'] },
  ZA: { names: ['south africa'], regions: ['emea', 'africa'] },
  NG: { names: ['nigeria'], regions: ['emea', 'africa'] },
  KE: { names: ['kenya'], regions: ['emea', 'africa'] },
  IN: { names: ['india'], regions: ['apac'] },
  PK: { names: ['pakistan'], regions: ['apac'] },
  PH: { names: ['philippines'], regions: ['apac'] },
  SG: { names: ['singapore'], regions: ['apac'] },
  JP: { names: ['japan'], regions: ['apac'] },
  VN: { names: ['vietnam'], regions: ['apac'] },
  ID: { names: ['indonesia'], regions: ['apac'] },
  AU: { names: ['australia'], regions: ['apac', 'oceania'] },
  NZ: { names: ['new zealand'], regions: ['apac', 'oceania'] },
};

const normalise = (text: string) =>
  text.toLowerCase().replace(/[.()]/g, '').replace(/\s+/g, ' ').trim();

const REGION_BY_NAME = new Map(
  Object.entries(REGIONS).flatMap(([region, names]) =>
    names.map((name) => [name, region] as const),
  ),
);
const COUNTRY_BY_NAME = new Map(
  Object.entries(COUNTRIES).flatMap(([code, country]) =>
    country.names.map((name) => [name, code] as const),
  ),
);

/** What a location token refers to, or `undefined` if we don't recognise it. */
export function recognisePlace(
  token: string,
): { country: string } | { region: string } | undefined {
  const name = normalise(token);
  const code =
    COUNTRY_BY_NAME.get(name) ??
    (/^[a-z]{2}$/.test(name) && name.toUpperCase() in COUNTRIES ? name.toUpperCase() : undefined);
  if (code) return { country: code };
  const region = REGION_BY_NAME.get(name);
  return region ? { region } : undefined;
}

/**
 * Can someone in one of `countries` take a job limited to `regions`?
 * `true` / `false` when every listed place is recognised; `undefined` when unsure.
 */
export function eligibleFor(
  regions: readonly string[],
  countries: readonly string[],
): boolean | undefined {
  if (regions.length === 0) return undefined;
  const places = regions.map(recognisePlace);
  const matches = places.some(
    (place) =>
      place !== undefined &&
      countries.some((code) =>
        'country' in place
          ? place.country === code
          : (COUNTRIES[code]?.regions.includes(place.region) ?? false),
      ),
  );
  if (matches) return true;
  return places.every((place) => place !== undefined) ? false : undefined;
}
