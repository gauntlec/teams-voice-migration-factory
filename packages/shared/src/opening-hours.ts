/*
 * Opening hours as people write them ("Mon-Fri 8:30-17:30, Sat 9am-12pm, closed Sunday") read into an auto attendant's weekly
 * business-hours schedule, so a "Change an auto attendant: opening hours" request can be applied without an engineer. Strict: any
 * part it cannot read, or a day given twice, gives null and the change stays a to-do for a person. Days not mentioned are closed.
 */
import type { AutoAttendantTimeRange } from './deployment';

export const WEEK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];
export type WeeklyHours = Record<WeekDay, AutoAttendantTimeRange[]>;

const DAY = '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?';
const GROUP = '(?:weekdays?|weekends?|daily|every\\s*day|7\\s*days(?:\\s*a\\s*week)?)';
const TIME = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?';
const RANGE_SEP = '\\s*(?:-|–|to|until|till)\\s*';

const TOKEN = new RegExp(
  [
    `(?<dayrange>${DAY}\\s*(?:-|–|to|through|thru)\\s*${DAY})(?![a-z])`,
    `(?<day>${DAY})(?![a-z])`,
    `(?<group>${GROUP})(?![a-z])`,
    `(?<time>${TIME}${RANGE_SEP}${TIME})(?![\\d:.])`,
    '(?<filler>[,&/:]|\\s+|\\b(?:and|open|from|on|closed|hours)\\b)',
  ].join('|'),
  'iy',
);

const dayIndex = (w: string): number | undefined => {
  const s = w.toLowerCase().replace(/s$/, '');
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const i = keys.findIndex((k) => s.startsWith(k));
  return i < 0 ? undefined : i;
};

function toMinutes(h: string, m: string, ap: string): number | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (hour > 24 || min > 59) return null;
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    if (/pm/i.test(ap) && hour !== 12) hour += 12;
    if (/am/i.test(ap) && hour === 12) hour = 0;
  }
  return hour * 60 + min;
}

const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** "9-5" means 9:00-17:00: a morning start with an end (no am/pm) not after it is taken as afternoon; "17-9" stays unreadable. */
function readRange(text: string): AutoAttendantTimeRange | null {
  const m = new RegExp(`^${TIME}${RANGE_SEP}${TIME}$`, 'i').exec(text.trim());
  if (!m) return null;
  const [, h1, m1 = '', ap1 = '', h2, m2 = '', ap2 = ''] = m;
  const start = toMinutes(h1!, m1, ap1);
  let end = toMinutes(h2!, m2, ap2);
  if (start === null || end === null) return null;
  if (!ap2 && end <= start && end < 12 * 60 && start < 12 * 60) end += 12 * 60;
  if (end <= start || end > 24 * 60) return null;
  return { start: hhmm(start), end: end === 24 * 60 ? '23:59' : hhmm(end) };
}

/** One segment ("Mon-Fri 9-12, 13-17" or "closed Sunday"): its days, its times, whether it says closed. Null if anything is unreadable. */
function readSegment(seg: string): { days: number[]; ranges: AutoAttendantTimeRange[]; closed: boolean } | null {
  const out = { days: [] as number[], ranges: [] as AutoAttendantTimeRange[], closed: /\bclosed\b/i.test(seg) };
  let pos = 0;
  while (pos < seg.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(seg);
    if (!m || m.index !== pos || !m[0].length) return null;
    pos += m[0].length;
    const g = m.groups!;
    if (g.dayrange) {
      const [a, b] = g.dayrange.split(/\s*(?:-|–|to|through|thru)\s*/i).map(dayIndex);
      if (a === undefined || b === undefined || b < a) return null;
      for (let d = a; d <= b; d++) out.days.push(d);
    } else if (g.day) {
      const d = dayIndex(g.day);
      if (d === undefined) return null;
      out.days.push(d);
    } else if (g.group) {
      out.days.push(...(/weekend/i.test(g.group) ? [5, 6] : /weekday/i.test(g.group) ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6]));
    } else if (g.time) {
      const r = readRange(g.time);
      if (!r) return null;
      out.ranges.push(r);
    }
  }
  return out;
}

export function parseOpeningHours(text: string): WeeklyHours | null {
  const week: WeeklyHours = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
  // A new segment starts at ; or a new line, or at a comma followed by days or "closed" - a comma between two times stays inside one.
  const segments = text
    .split(new RegExp(`[;\\n]+|,(?=\\s*(?:closed|${GROUP}|${DAY})(?![a-z]))`, 'i'))
    .map((x) => x.trim())
    .filter(Boolean);
  if (!segments.length) return null;
  const seen = new Set<number>();
  let carried: number[] = [];
  for (const seg of segments) {
    const r = readSegment(seg);
    if (!r) return null;
    // "Mon, Wed & Fri 9-1": days with nothing of their own belong to the next segment's times.
    if (!r.closed && !r.ranges.length) {
      carried.push(...r.days);
      continue;
    }
    r.days.unshift(...carried);
    carried = [];
    if (!r.days.length) return null;
    if (r.closed === r.ranges.length > 0) return null; // "closed" with times, or days with neither
    for (const d of r.days) {
      if (seen.has(d)) return null;
      seen.add(d);
      const day = week[WEEK_DAYS[d]!];
      for (const range of r.ranges) {
        if (day.some((x) => x.start < range.end && range.start < x.end)) return null;
        day.push(range);
      }
      day.sort((a, b) => a.start.localeCompare(b.start));
    }
  }
  if (carried.length) return null;
  return WEEK_DAYS.some((d) => week[d].length) ? week : null;
}

/** "Mon-Fri 08:30-17:30; Sat 09:00-12:00; closed otherwise" - how a schedule reads back, for the timeline. */
export function describeWeeklyHours(w: WeeklyHours): string {
  const label = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const key = (i: number) => w[WEEK_DAYS[i]!].map((r) => `${r.start}-${r.end}`).join(', ');
  const out: string[] = [];
  let i = 0;
  while (i < 7) {
    const k = key(i);
    let j = i;
    while (j + 1 < 7 && key(j + 1) === k) j++;
    if (k) out.push(`${label[i]}${j > i ? `-${label[j]}` : ''} ${k}`);
    i = j + 1;
  }
  return out.length ? `${out.join('; ')}; closed otherwise` : 'Closed all week';
}
