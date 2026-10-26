/*
 * Auto attendant and call queue settings Microsoft documents as PowerShell only (not shown in Teams Admin Center):
 * -HideAuthorizedUsers (authorised users who should not appear as such), the auto attendant's dial-by-name -UserNameExtension,
 * and the call queue's -SharedVoicemailTriageSettingsTemplateId. Authorised users themselves (-AuthorizedUsers) are modelled
 * alongside, since the hidden list is a subset of them.
 *
 * A design value of null means "not managed by Voxshift": the deployment leaves whatever Teams has. Only a set value (an empty
 * list included) is compared and deployed, so a row made before these existed never removes anyone's access.
 */

/** Teams takes audio prompts up to 5 MB, as WAV, MP3 or WMA. */
export const VOICE_AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/x-ms-wma'] as const;

/** How dial-by-name results are told apart when two people share a name (New-CsAutoAttendant -UserNameExtension). */
export const USER_NAME_EXTENSIONS = ['None', 'Office', 'Department'] as const;
export type UserNameExtension = (typeof USER_NAME_EXTENSIONS)[number];

/** Get-CsAutoAttendant writes -UserNameExtension as its name or its enum number. */
export function decodeUserNameExtension(v: unknown): UserNameExtension | undefined {
  if (typeof v === 'string') return USER_NAME_EXTENSIONS.find((x) => x.toLowerCase() === v.toLowerCase());
  if (typeof v === 'number') return USER_NAME_EXTENSIONS[v];
  return undefined;
}

/** A list of Entra object ids as Get-CsAutoAttendant / Get-CsCallQueue write them (strings, or objects with Id). */
export function liveIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { Id?: unknown }).Id === 'string' ? (x as { Id: string }).Id : null))
    .filter((x): x is string => !!x);
}

/** The same people, in any order and case. */
export function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
  const norm = (x: string[] | undefined) => [...new Set((x ?? []).map((s) => s.toLowerCase()))].sort().join(',');
  return norm(a) === norm(b);
}

/** Design UPNs to the Entra object ids a cmdlet takes; UPNs not found are left out (warned about separately). */
export function resolveUpnIds(upns: string[] | null | undefined, ids: Map<string, string>): string[] {
  return (upns ?? []).map((u) => ids.get(u.toLowerCase())).filter((x): x is string => !!x);
}

/** Warnings for a voice app's access lists: people not found, and hidden people who are not authorised users. */
export function accessWarnings(authorized: string[] | null | undefined, hidden: string[] | null | undefined, ids: Map<string, string>): string[] {
  const out: string[] = [];
  const missing = [...(authorized ?? []), ...(hidden ?? [])].filter((u) => !ids.has(u.toLowerCase()));
  if (missing.length) out.push(`${missing.length} authorised user(s) not found in the tenant's synced users, so they'll be skipped: ${[...new Set(missing)].join(', ')}`);
  const auth = new Set((authorized ?? []).map((u) => u.toLowerCase()));
  const notAuth = (hidden ?? []).filter((u) => !auth.has(u.toLowerCase()));
  if (hidden?.length && notAuth.length) out.push(`Hidden authorised users must also be authorised users: ${notAuth.join(', ')}`);
  return out;
}
