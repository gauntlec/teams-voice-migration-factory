/**
 * Latitude and longitude pasted as one string, the way Google Maps (and most map sites) copy them:
 * "40.8209442, -73.2492744". Returns both numbers as plain text, or null when the text is not a pair
 * of valid coordinates (latitude -90..90, longitude -180..180).
 */
export function parseCoordinatePair(text: string): { latitude: string; longitude: string } | null {
  const m = /^\s*\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*°?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*\)?\s*$/.exec(text);
  const latitude = m?.[1];
  const longitude = m?.[2];
  if (latitude === undefined || longitude === undefined) return null;
  if (!(Math.abs(Number(latitude)) <= 90) || !(Math.abs(Number(longitude)) <= 180)) return null;
  return { latitude, longitude };
}

/** True while `text` could still become a valid coordinate as it is typed: an optional minus, digits and one dot. */
export function isCoordinateText(text: string): boolean {
  return /^-?\d*\.?\d*$/.test(text.trim());
}
