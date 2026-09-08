import { Injectable, Logger } from '@nestjs/common';

export interface GeocodeHit {
  latitude: number;
  longitude: number;
  label: string;
  /** true when only the town/area matched, not the street address */
  approximate: boolean;
}

const UA = 'TeamsVoiceMigrationFactory/1.0 (+https://www.directrouting.online)';
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/**
 * Street address -> coordinates, via OpenStreetMap's Nominatim (same project
 * as our map tiles; no API key). Nominatim asks for <= 1 request/second and a
 * real User-Agent, so calls are serialised with a 1s floor and results cached.
 * Returns null for "no match" and for any network / timeout failure.
 */
@Injectable()
export class GeocodeService {
  private readonly log = new Logger(GeocodeService.name);
  private readonly cache = new Map<string, GeocodeHit | null>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;

  async lookup(rawAddress: string): Promise<GeocodeHit | null> {
    const raw = (rawAddress || '').replace(/\s+/g, ' ').trim();
    if (raw.length < 4) return null;
    // Nominatim is fussy about abbreviations, unit numbers and apostrophes, so
    // try (1) a cleaned form, (2) the address as typed, (3) just the locality
    // (town + state + zip) for an approximate pin.
    const cleaned = normalise(raw);
    const locality = cleaned.split(',').slice(1).join(',').trim();
    const attempts: { q: string; approximate: boolean }[] = [];
    for (const q of [cleaned, raw]) if (q.length >= 4) attempts.push({ q, approximate: false });
    if (locality.length >= 4) attempts.push({ q: locality, approximate: true });

    const cacheKey = attempts.map((a) => a.q).join(' || ').toLowerCase();
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;

    // Serialise + throttle to honour the Nominatim usage policy.
    const run = this.queue.then(async () => {
      if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
      let hit: GeocodeHit | null = null;
      for (const { q, approximate } of attempts) {
        const wait = 1000 - (Date.now() - this.lastCall);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastCall = Date.now();
        hit = await this.fetchOne(q, approximate);
        if (hit) break;
      }
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(cacheKey, hit);
      return hit;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchOne(query: string, approximate: boolean): Promise<GeocodeHit | null> {
    const url = `${ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log.warn(`Nominatim ${res.status} for "${query}"`);
        return null;
      }
      const arr = (await res.json()) as Array<{
        lat: string;
        lon: string;
        display_name: string;
        addresstype?: string;
      }>;
      const first = arr[0];
      if (!first) return null;
      const latitude = Number(first.lat);
      const longitude = Number(first.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const streetLevel = ['building', 'house', 'road', 'place', 'address'].includes(
        first.addresstype ?? '',
      );
      return { latitude, longitude, label: first.display_name, approximate: approximate || !streetLevel };
    } catch (e) {
      this.log.warn(`Nominatim lookup failed for "${query}": ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

const STREET_TYPES: Record<string, string> = {
  st: 'Street',
  ave: 'Avenue',
  av: 'Avenue',
  rd: 'Road',
  dr: 'Drive',
  blvd: 'Boulevard',
  ln: 'Lane',
  ct: 'Court',
  pkwy: 'Parkway',
  hwy: 'Highway',
  sq: 'Square',
  ter: 'Terrace',
  pl: 'Place',
  cir: 'Circle',
  trl: 'Trail',
};

/**
 * Nominatim geocodes full words better than postal abbreviations and chokes on
 * unit numbers, so: strip Suite/Apt/etc, drop the comma before a ZIP, expand
 * common street-type abbreviations, tidy punctuation. Case is preserved.
 */
function normalise(raw: string): string {
  return raw
    .replace(/[.\t]/g, ' ')
    .replace(/\r?\n/g, ', ')
    .replace(/\b(suite|ste|apt|apartment|unit|fl|floor|rm|room|bldg|building)\b[\s#]*[\w-]+/gi, '')
    .replace(/#\s*[\w-]+/g, '')
    // expand a street-type abbrev only where it sits as the street suffix:
    // preceded by a name word, followed by a comma or the end of the string.
    .replace(
      /(?<=\w\s)(st|ave|av|rd|dr|blvd|ln|ct|pkwy|hwy|sq|ter|pl|cir|trl)(?=\s*(?:,|$))/gi,
      (m) => STREET_TYPES[m.toLowerCase()] ?? m,
    )
    .replace(/,\s*(\d{5}(?:-\d{4})?)\b/, ' $1')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .slice(0, 300);
}
