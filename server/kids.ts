// Kids mode: which titles a kids profile sees, and what it may do.

/** Age ratings from TMDB, for the countries the rule reads. */
export type Certs = Partial<Record<'DE' | 'FR' | 'US', string>>;

export const CERT_COUNTRIES = ['DE', 'FR', 'US'] as const;

const DE: Record<string, number> = { '0': 0, '6': 6, '12': 12, '16': 16, '18': 18 };
const FR: Record<string, number> = { TP: 0, U: 0, '10': 10, '12': 12, '16': 16, '18': 18 };
const US: Record<string, number> = {
  G: 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, PG: 8, 'TV-PG': 10, 'PG-13': 13, 'TV-14': 14, R: 17, 'TV-MA': 17, 'NC-17': 18,
};

/**
 * The age a title is rated for: Germany's (FSK) when there is one, else the stricter of France's and the
 * US's (France is lenient: it rates some adult anime "Tous publics"). None of them: no rating.
 */
export function ageOf(certs: Certs | null | undefined): number | undefined {
  if (!certs) return undefined;
  const de = DE[certs.DE ?? ''];
  if (de !== undefined) return de;
  const others = [FR[(certs.FR ?? '').replace(/^-/, '')], US[certs.US ?? '']].filter((a) => a !== undefined);
  return others.length ? Math.max(...others) : undefined;
}
