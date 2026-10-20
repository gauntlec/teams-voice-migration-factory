import { describe, expect, it } from 'vitest';
import { cleanEmailReply, emailOf, emailSubjectToTitle, inboundEmailSchema, inboundReplyAddress, inboundTarget, isAutoReply } from './inbound-email';

const BASE = 'incidents@mail.voxshift.example';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz'.replace(/[01689]/g, '').slice(0, 26);

describe('addresses', () => {
  it('builds a reply address, and finds the token in a message\'s addresses however they are written', () => {
    const t = 'k3j2h4g5f6d7s2a3q4w5e6r7ty';
    expect(t).toHaveLength(26);
    expect(inboundReplyAddress(BASE, t)).toBe(`incidents+${t}@mail.voxshift.example`);
    expect(inboundTarget([`"Voxshift" <incidents+${t}@mail.voxshift.example>`], BASE)).toEqual({ kind: 'reply', token: t });
    expect(inboundTarget([`INCIDENTS+${t.toUpperCase()}@MAIL.VOXSHIFT.EXAMPLE`], BASE)).toEqual({ kind: 'reply', token: t });
    expect(inboundTarget(['someone@else.com', `incidents+${t}@mail.voxshift.example`], BASE)).toEqual({ kind: 'reply', token: t });
  });
  it('treats the bare address as "raise one", a plus-tag that is not a token as a hint, and anything else as not ours', () => {
    expect(inboundTarget([BASE], BASE)).toEqual({ kind: 'raise', hint: null });
    expect(inboundTarget(['incidents+contoso@mail.voxshift.example'], BASE)).toEqual({ kind: 'raise', hint: 'contoso' });
    expect(inboundTarget(['incidents@other.example', 'a@b.c'], BASE)).toBeNull();
    expect(inboundTarget(['sales+x@mail.voxshift.example'], BASE)).toBeNull();
    // A token beats the bare address.
    const t = 'k3j2h4g5f6d7s2a3q4w5e6r7ty';
    expect(inboundTarget([BASE, `incidents+${t}@mail.voxshift.example`], BASE)).toMatchObject({ kind: 'reply' });
  });
  it('extracts the address from a display name form', () => {
    expect(emailOf('Cara <Cara@Contoso.com>')).toBe('cara@contoso.com');
    expect(emailOf(' a@b.c ')).toBe('a@b.c');
  });
  it('takes the first <...> with something inside, as before', () => {
    expect(emailOf('<>x <A@B.C>')).toBe('a@b.c');
    expect(emailOf('<<a@b.c>')).toBe('<a@b.c');
    expect(emailOf('no brackets <')).toBe('no brackets <');
  });
  it('stays fast on a long run of "<" (no quadratic regex)', () => {
    const t = Date.now();
    emailOf('<'.repeat(200_000));
    emailOf('<>'.repeat(100_000));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('auto replies', () => {
  const human = { subject: 'Re: INC-0042', from: 'cara@contoso.com' };
  it('lets a person through', () => expect(isAutoReply(human)).toBe(false));
  it('catches out-of-office, bounces, list mail and no-reply senders', () => {
    expect(isAutoReply({ ...human, headers: { 'Auto-Submitted': 'auto-replied' } })).toBe(true);
    expect(isAutoReply({ ...human, headers: { 'Auto-Submitted': 'no' } })).toBe(false);
    expect(isAutoReply({ ...human, headers: { Precedence: 'bulk' } })).toBe(true);
    expect(isAutoReply({ ...human, headers: { 'X-Auto-Response-Suppress': 'DR, RN, NRN, OOF, AutoReply' } })).toBe(true);
    expect(isAutoReply({ ...human, headers: { 'List-Id': '<news.example>' } })).toBe(true);
    expect(isAutoReply({ subject: 'Automatic reply: INC-0042', from: 'cara@contoso.com' })).toBe(true);
    expect(isAutoReply({ subject: 'Out of office until Monday', from: 'cara@contoso.com' })).toBe(true);
    expect(isAutoReply({ subject: 'Undeliverable: INC-0042', from: 'postmaster@contoso.com' })).toBe(true);
    expect(isAutoReply({ subject: 'hello', from: 'noreply@contoso.com' })).toBe(true);
    expect(isAutoReply({ subject: 'hello', from: 'MAILER-DAEMON@x.com' })).toBe(true);
  });
});

describe('titles', () => {
  it('drops Re:/Fwd: and reference tags', () => {
    expect(emailSubjectToTitle('RE: Fwd: [INC-0042] Calls are dropping')).toBe('Calls are dropping');
    expect(emailSubjectToTitle('  ', 'cara@contoso.com')).toBe('Email from cara@contoso.com');
    expect(emailSubjectToTitle('x'.repeat(400))).toHaveLength(160);
  });
});

describe('cleaning a reply', () => {
  it('keeps what was written and cuts the quoted thread (On ... wrote:)', () => {
    const t = 'Yes, it is still happening.\nIt started again at 10:15.\n\nThanks,\nCara\n\nOn Tue, 14 Oct 2026 at 09:30, Voxshift <incidents@mail.voxshift.example> wrote:\n> We are looking at it.\n> Update soon.';
    expect(cleanEmailReply(t)).toBe('Yes, it is still happening.\nIt started again at 10:15.\n\nThanks,\nCara');
  });
  it('handles a wrapped "On ... wrote:", Outlook headers, original-message separators and signatures', () => {
    expect(cleanEmailReply('Fixed now.\n\nOn Tue, 14 Oct 2026 at 09:30, Voxshift <incidents@mail.voxshift.example>\nwrote:\n> hi')).toBe('Fixed now.');
    expect(cleanEmailReply('Please call me.\n\nFrom: Voxshift\nSent: 14 October 2026 09:30\nTo: Cara\nSubject: INC-0042\n\nWe are on it.')).toBe('Please call me.');
    expect(cleanEmailReply('Done.\n-----Original Message-----\nFrom: x')).toBe('Done.');
    expect(cleanEmailReply('Done.\n\n-- \nCara Customer\nContoso')).toBe('Done.');
    expect(cleanEmailReply('Done.\n\nSent from my iPhone')).toBe('Done.');
    expect(cleanEmailReply('Line one\n> quoted\nLine two')).toBe('Line one\nLine two');
  });
  it('keeps a sentence that merely starts with "On" or "From:", is empty when nothing new was written, and is capped', () => {
    expect(cleanEmailReply('On Monday it worked.\nFrom: now on it fails.')).toBe('On Monday it worked.\nFrom: now on it fails.');
    expect(cleanEmailReply('> only quoted\n> text')).toBe('');
    expect(cleanEmailReply('x'.repeat(9000))).toHaveLength(4000);
    expect(cleanEmailReply('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
  });
});

describe('payload', () => {
  it('needs the forwarder to vouch for the sender, and defaults to not', () => {
    const p = inboundEmailSchema.parse({ messageId: '<1@x>', from: { email: 'cara@contoso.com' }, to: [BASE] });
    expect(p).toMatchObject({ authenticated: false, subject: '', text: '' });
    expect(inboundEmailSchema.safeParse({ messageId: '<1@x>', from: { email: 'a@b.c' }, to: [] }).success).toBe(false);
    expect(inboundEmailSchema.safeParse({ messageId: '<1@x>', from: { email: 'a@b.c' }, to: [BASE], evil: 1 }).success).toBe(false);
  });
  void TOKEN;
});
