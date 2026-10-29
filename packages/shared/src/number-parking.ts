/**
 * Parked numbers. A parked number is a spare the customer keeps with the carrier for a small retention fee instead of the
 * full fee of a working number, so it cannot be given to a user, phone or resource account until it is brought back into use.
 *
 * While a site is in project mode a project manager or engineer parks and unparks numbers on the site's Numbers tab, and
 * parks the spares before the site moves to operations. Once the site is in operations the Numbers tab no longer changes
 * them: a "Park or unpark phone numbers" service request does, when an engineer completes it.
 */

/** The choices on a "Park or unpark phone numbers" request. */
export const NUMBER_PARK = 'Park them';
export const NUMBER_UNPARK = 'Bring them back into use';

/** The message when someone tries to give a parked number to a holder. */
export const PARKED_NUMBER_MESSAGE =
  'That number is parked: the customer keeps it with the carrier for a retention fee. Bring it back into use before giving it to anyone.';

/** The message when the Numbers tab is asked to park or unpark at a site that is in operations. */
export function parkingInOperationsMessage(sitecode: string): string {
  return `${sitecode} is in operations, so its numbers are parked or brought back into use through a "Park or unpark phone numbers" service request.`;
}

interface NumberState {
  e164: string;
  status: string;
  live_status?: string | null;
}

/** Why a number can't be parked now, or null when it can. Only a spare number that Teams does not have in use can be. */
export function parkBlockReason(n: NumberState): string | null {
  if (n.status === 'parked') return `${n.e164} is already parked.`;
  if (n.status === 'assigned' || n.live_status) return `${n.e164} is in use. Take it off its holder first.`;
  if (n.status === 'reserved') return `${n.e164} is reserved. Release the reservation first.`;
  return null;
}

/** Why a number can't be brought back into use, or null when it can. */
export function unparkBlockReason(n: NumberState): string | null {
  return n.status === 'parked' ? null : `${n.e164} is not parked.`;
}
