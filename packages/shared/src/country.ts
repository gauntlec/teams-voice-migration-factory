/**
 * Country names as people type them ("UK", "USA", "United Kingdom") to the two-letter ISO code Teams uses for a user's usage
 * location ("GB", "US"). Returns null when the text is not a country we recognise, so a caller never guesses.
 */

const ALIASES: Record<string, string> = {
  uk: 'GB',
  'u.k.': 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  'united states of america': 'US',
  uae: 'AE',
  'south korea': 'KR',
  korea: 'KR',
  russia: 'RU',
  holland: 'NL',
  'the netherlands': 'NL',
  'republic of ireland': 'IE',
  eire: 'IE',
  czechia: 'CZ',
  'czech republic': 'CZ',
  turkey: 'TR',
  turkiye: 'TR',
  vietnam: 'VN',
  'hong kong': 'HK',
};

/** ISO 3166-1 alpha-2: the codes a usage location can hold. (Intl also names retired and reserved codes such as DD and UK.) */
const ISO_CODES = new Set(
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '),
);

let byName: Map<string, string> | null = null;
let regionNames: Intl.DisplayNames | null = null;

function names(): Intl.DisplayNames {
  regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
  return regionNames;
}

function nameMap(): Map<string, string> {
  if (byName) return byName;
  const m = new Map<string, string>();
  for (const code of ISO_CODES) {
    try {
      const label = names().of(code);
      if (label && label !== code) m.set(label.toLowerCase(), code);
    } catch {
      /* no name for it in this runtime */
    }
  }
  byName = m;
  return m;
}

export function countryToIso(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const key = t.toLowerCase().replace(/\s+/g, ' ');
  // Short forms first: "UK" is not an ISO code even though it looks like one.
  if (ALIASES[key]) return ALIASES[key];
  if (/^[A-Za-z]{2}$/.test(t)) return ISO_CODES.has(t.toUpperCase()) ? t.toUpperCase() : null;
  return nameMap().get(key) ?? null;
}

/**
 * A user's usage location in the tenant against the country of the site they are being enabled at. null = fine, or nothing to compare
 * (the site's country is not set or not recognised). A user with no usage location at all is a mismatch.
 */
export function usageLocationMismatch(
  liveUsageLocation: string | null | undefined,
  siteCountry: string | null | undefined,
): { live: string | null; expected: string; country: string } | null {
  const expected = countryToIso(siteCountry);
  const country = (siteCountry ?? '').trim();
  if (!expected || !country) return null;
  const live = (liveUsageLocation ?? '').trim().toUpperCase() || null;
  return live === expected ? null : { live, expected, country };
}

/** "United Kingdom" for "GB", or the code itself when it is not one we can name. */
export function countryLabel(iso: string): string {
  try {
    return names().of(iso.toUpperCase()) ?? iso;
  } catch {
    return iso;
  }
}
