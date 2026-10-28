const LATITUDE_TEXT = /^-?\d{1,2}(?:\.\d+)?$/;
const LONGITUDE_TEXT = /^-?\d{1,3}(?:\.\d+)?$/;

/**
 * Latitude and longitude pasted as one string, the way Google Maps (and most map sites) copy them:
 * "40.8209442, -73.2492744". Returns both numbers as plain text, or null when the text is not a pair
 * of valid coordinates (latitude -90..90, longitude -180..180).
 */
export function parseCoordinatePair(text: string): { latitude: string; longitude: string } | null {
  // Cut into the two numbers with plain string steps, not one long pattern full of optional spaces (which can backtrack very slowly).
  let s = text.trim();
  if (s.startsWith('(')) s = s.slice(1).trim();
  if (s.endsWith(')')) s = s.slice(0, -1).trim();
  if (s.endsWith('°')) s = s.slice(0, -1).trim(); // one degree sign after the second number
  const bySpace = !s.includes(',') && !s.includes(';');
  let parts = bySpace ? s.split(/\s+/) : s.includes(',') ? s.split(',') : s.split(';');
  if (bySpace && parts.length === 3 && parts[1] === '°') parts = [parts[0]!, parts[2]!]; // "40.8 ° -73.2"
  if (parts.length !== 2) return null;
  let latitude = parts[0]!.trim();
  if (latitude.endsWith('°')) latitude = latitude.slice(0, -1).trim(); // one degree sign after the first number
  const longitude = parts[1]!.trim();
  if (!LATITUDE_TEXT.test(latitude) || !LONGITUDE_TEXT.test(longitude)) return null;
  if (!(Math.abs(Number(latitude)) <= 90) || !(Math.abs(Number(longitude)) <= 180)) return null;
  return { latitude, longitude };
}

/** True while `text` could still become a valid coordinate as it is typed: an optional minus, digits and one dot. */
export function isCoordinateText(text: string): boolean {
  return /^-?\d*(?:\.\d*)?$/.test(text.trim());
}
