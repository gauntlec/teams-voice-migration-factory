import { describe, expect, it } from 'vitest';
import { columnWidths, wordsFit } from './column-widths';

// The text width of a US Letter page with the pack's 1 inch margins, and 10pt.
const LETTER = 9360;
const BODY = 20;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const usersTable = ['User Principal Name (UPN)', 'DID Number', 'Physical Phone', 'Voice Routing Policy'];

describe('handover table column widths', () => {
  it('leaves a voice routing policy room to stay on one line (the complaint on the Teams users table)', () => {
    const w = columnWidths(usersTable, [['aamir.faheem@parker.com', '16316392638', 'No', 'TEL-US-National']], LETTER, BODY);
    expect(sum(w)).toBe(LETTER);
    // "TEL-US-National" needs about 1450, and its title about 2050
    expect(w[3]!).toBeGreaterThan(2050);
    // and the UPN no longer takes half the table
    expect(w[0]! / LETTER).toBeLessThan(0.4);
  });

  it('gives a very long UPN what it needs, from the columns with room to spare', () => {
    const w = columnWidths(usersTable, [['fsd02d-cap-us-hauppauge-receiving-dock@parker.com', '16316392638', 'No', 'TEL-US-International']], LETTER, BODY);
    expect(sum(w)).toBe(LETTER);
    expect(w[0]!).toBeGreaterThan(4800); // the UPN fits on one line
    expect(w[3]!).toBeGreaterThan(1950); // and so does the policy
    expect(w[1]!).toBeGreaterThan(1300); // and the number
  });

  it('wraps the long text, not the short columns', () => {
    const note = 'This phone is in the loading bay and is shared by the morning and evening shifts, so it was left on the old number until the site confirms the change. '.repeat(3);
    const w = columnWidths(['Number', 'Site', 'Note'], [['+16316392638', 'FSD02D', note]], LETTER, BODY);
    expect(sum(w)).toBe(LETTER);
    expect(w[0]!).toBeGreaterThan(1300);
    expect(w[1]!).toBeGreaterThan(800);
    expect(w[2]!).toBeGreaterThan(w[0]! + w[1]!);
  });

  it('fills the width on a table with short values, and on an empty one', () => {
    expect(sum(columnWidths(['Site', 'Scope'], [['A', 'b']], LETTER, BODY))).toBe(LETTER);
    expect(sum(columnWidths(['Name', 'Email', 'Members', 'Owners'], [], LETTER, BODY))).toBe(LETTER);
    expect(sum(columnWidths(['Voice Routing Policy'], [], 5616, BODY))).toBe(5616);
  });

  it('breaks a UPN too long for the table after a hyphen, keeping the 10pt and the short values on one line', () => {
    const columns = ['UPN', 'Display name', 'Type', 'Site', 'Phone number', 'Voice routing policy'];
    const rows = [['aa-us-fsd02d-mainnumbertollfree@parker.com', 'Hauppauge Main Number', 'Auto Attendant', 'FSD02D', '+16312313737', 'TEL-US-National']];
    expect(wordsFit(columns, rows, LETTER, BODY)).toBe(true);
    const w = columnWidths(columns, rows, LETTER, BODY);
    expect(sum(w)).toBe(LETTER);
    expect(w[5]!).toBeGreaterThan(1511); // the policy: 1311 of text and 200 of cell margins
    expect(w[4]!).toBeGreaterThan(1450); // the number
  });

  it('never gives a column nothing when the words cannot all fit, and says so the table can step down a size', () => {
    const upn = 'averylongresourceaccountnameindeedthatwordcannotbreak@alongcustomerdomainname.example.com';
    const rows = [[upn, upn, upn]];
    expect(wordsFit(['A', 'B', 'C'], rows, LETTER, BODY)).toBe(false);
    const w = columnWidths(['A', 'B', 'C'], rows, LETTER, BODY);
    expect(sum(w)).toBe(LETTER);
    expect(Math.min(...w)).toBeGreaterThan(0);
  });

  it('measures each line of a value on its own', () => {
    const one = columnWidths(['Agents', 'Site'], [['amy@contoso.test\nben@contoso.test\ncat@contoso.test', 'RDG01']], LETTER, BODY);
    const all = columnWidths(['Agents', 'Site'], [['amy@contoso.test ben@contoso.test cat@contoso.test', 'RDG01']], LETTER, BODY);
    expect(one[1]! / one[0]!).toBeGreaterThan(all[1]! / all[0]!);
  });
});
