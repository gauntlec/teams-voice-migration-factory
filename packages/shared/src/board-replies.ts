import { z } from 'zod';

/**
 * Replies on a Bug reports or Feature requests card (migration 0045): the reporter answering our questions, staff asking more, anyone who
 * can see the board adding feedback. Anyone who can see a board can reply on any of its cards; a reply can carry one file.
 */

/** Longest reply, in characters. Room for a careful answer to several questions; not a place for a pasted log (attach it). */
export const BOARD_REPLY_MAX_CHARS = 10_000;

/** A file that came with a reply. The bytes are fetched from the card's attachment route. */
export interface BoardReplyAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
}

export interface BoardReply {
  id: string;
  body: string;
  author_id: string | null;
  /** Null when the author's account has gone. */
  author_name: string | null;
  created_at: string;
  attachments: BoardReplyAttachment[];
}

/** The text of a reply. Sent as a form field next to the optional file, so it is a plain string. */
export const boardReplyCreateSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a reply.')
    .max(BOARD_REPLY_MAX_CHARS, `A reply can be ${BOARD_REPLY_MAX_CHARS.toLocaleString('en-GB')} characters at most. Attach anything longer as a file.`),
});
export type BoardReplyCreateInput = z.infer<typeof boardReplyCreateSchema>;

/**
 * The "Replies" section of a card's AI prompt (the board's Prompt button), oldest first, so whoever works the card sees the answers given on
 * it. Empty when there are none, so the prompt reads as it did before replies existed.
 */
export function boardRepliesForPrompt(replies: readonly BoardReply[]): string[] {
  if (!replies.length) return [];
  const lines = ['## Replies on the card (oldest first)', ''];
  for (const r of replies) {
    lines.push(`**${r.author_name ?? 'Unknown'}** - ${promptTime(r.created_at)}`);
    // Quote every line so a reply cannot be read as part of the prompt's own structure (a reply's "# heading" stays inside the quote).
    for (const l of r.body.split(/\r?\n/)) lines.push(l ? `> ${l}` : '>');
    if (r.attachments.length) lines.push(`> _Attached: ${r.attachments.map((a) => a.filename).join(', ')}_`);
    lines.push('');
  }
  return lines;
}

/** "2026-11-11 14:05 UTC": the same for everyone who copies the prompt, wherever they are. */
function promptTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
