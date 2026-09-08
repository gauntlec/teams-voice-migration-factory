import { randomInt } from 'node:crypto';

// No 0/O/1/I/l - easy to read aloud or copy from an email.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
const GROUPS = 3;
const GROUP_LEN = 6;

/**
 * A one-time password emailed in an invitation. 18 chars of entropy from the
 * unambiguous alphabet, shown as `xxxxxx-xxxxxx-xxxxxx`. Always >= 12 chars so it
 * satisfies `passwordSchema` if it is ever validated.
 */
export function generateTempPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let s = '';
    for (let i = 0; i < GROUP_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}
