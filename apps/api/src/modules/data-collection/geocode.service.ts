import { Injectable, Logger } from '@nestjs/common';

export interface GeocodeHit {
  latitude: number;
  longitude: number;
  label: string;
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
    const query = normalise(rawAddress);
    if (query.length < 4) return null;
    if (this.cache.has(query)) return this.cache.get(query) ?? null;

    // Serialise + throttle to honour the Nominatim usage policy.
    const run = this.queue.then(async () => {
      if (this.cache.has(query)) return this.cache.get(query) ?? null;
      const wait = 1000 - (Date.now() - this.lastCall);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      const hit = await this.fetchOne(query);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(query, hit);
      return hit;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchOne(query: string): Promise<GeocodeHit | null> {
    const url = `${ENDPOINT}?format=json&limit=1&q=${encodeURIComponent(query)}`;
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
      const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      const first = arr[0];
      if (!first) return null;
      const latitude = Number(first.lat);
      const longitude = Number(first.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return { latitude, longitude, label: first.display_name };
    } catch (e) {
      this.log.warn(`Nominatim lookup failed for "${query}": ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Nominatim dislikes unit numbers and stray punctuation - strip them. */
function normalise(raw: string): string {
  return (raw || '')
    .replace(/[.\t]/g, ' ')
    .replace(/\r?\n/g, ', ')
    .replace(/\b(suite|ste|apt|apartment|unit|fl|floor|rm|room|bldg|building)\b[\s#]*[\w-]+/gi, '')
    .replace(/#\s*[\w-]+/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .toLowerCase()
    .slice(0, 300);
}
