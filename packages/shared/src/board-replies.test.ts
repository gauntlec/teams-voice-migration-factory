import { describe, expect, it } from 'vitest';
import { boardRepliesForPrompt, boardReplyCreateSchema, BOARD_REPLY_MAX_CHARS, type BoardReply } from './board-replies';

const reply = (over: Partial<BoardReply> = {}): BoardReply => ({
  id: 'r1',
  body: 'Yes, show it on every site.',
  author_id: 'u1',
  author_name: 'Reporter',
  created_at: '2026-11-11T14:05:09.000Z',
  attachments: [],
  ...over,
});

describe('boardRepliesForPrompt', () => {
  it('adds nothing when a card has no replies', () => {
    expect(boardRepliesForPrompt([])).toEqual([]);
  });

  it('lists each reply oldest first with its author, time and files, quoted', () => {
    const lines = boardRepliesForPrompt([
      reply(),
      reply({ id: 'r2', author_name: null, body: '1. Yes\n\n# 2. No', created_at: '2026-11-11T15:00:00.000Z', attachments: [{ id: 'a', filename: 'Mock-up.pdf', content_type: 'application/pdf', size: 3 }] }),
    ]);
    expect(lines.join('\n')).toBe(
      [
        '## Replies on the card (oldest first)',
        '',
        '**Reporter** - 2026-11-11 14:05 UTC',
        '> Yes, show it on every site.',
        '',
        '**Unknown** - 2026-11-11 15:00 UTC',
        '> 1. Yes',
        '>',
        '> # 2. No',
        '> _Attached: Mock-up.pdf_',
        '',
      ].join('\n'),
    );
  });
});

describe('boardReplyCreateSchema', () => {
  it('trims, and refuses an empty or over-long reply', () => {
    expect(boardReplyCreateSchema.parse({ body: '  thanks  ' })).toEqual({ body: 'thanks' });
    expect(boardReplyCreateSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(boardReplyCreateSchema.safeParse({ body: 'x'.repeat(BOARD_REPLY_MAX_CHARS + 1) }).success).toBe(false);
  });
});
