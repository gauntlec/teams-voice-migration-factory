import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button, Link, MessageBar, MessageBarBody, Spinner, Text, Textarea, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { AttachRegular, ChatRegular, DeleteRegular, DismissRegular, SendRegular } from '@fluentui/react-icons';
import { BOARD_REPLY_MAX_CHARS, BUG_ATTACHMENT_MAX_BYTES, type BoardReply } from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';

/**
 * The reply thread on a Bug reports or Feature requests card (migration 0045), shared by both boards. Anyone who can see the board replies
 * on any card, with one optional file; the author or an administrator deletes a reply. The card shows how many replies it has, marked when
 * one has come in since you last opened the card (remembered in this browser only).
 */

export type BoardPath = '/bug-reports' | '/feature-requests';

const repliesKey = (path: BoardPath, cardId: string) => ['board-replies', path, cardId];

/** The replies on a card, fresh from the server: for the Prompt button, so the copied prompt has the latest answers. */
export function fetchReplies(qc: QueryClient, path: BoardPath, cardId: string): Promise<BoardReply[]> {
  return qc.fetchQuery({ queryKey: repliesKey(path, cardId), queryFn: () => api<BoardReply[]>(`${path}/${cardId}/replies`), staleTime: 0 });
}

/* ------------------------------ clipboard ------------------------------ */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copies text that has to be fetched first (a prompt with the card's replies). Safari only lets a page write to the clipboard during the
 * click itself, so the write starts straight away with the text still on its way (a ClipboardItem given a promise); where that is not
 * supported, the text is fetched and then copied as usual.
 */
export async function copyTextLater(getText: () => Promise<string>): Promise<boolean> {
  const pending = getText();
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write && window.isSecureContext) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': pending.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    return await copyText(await pending);
  } catch {
    return false;
  }
}

/* ----------------------------- "new reply" ----------------------------- */

const SEEN_EVENT = 'voxshift-board-replies-seen';
const seenKey = (cardId: string) => `voxshift.boardReplySeen.${cardId}`;

function readSeen(cardId: string): string | null {
  try {
    return localStorage.getItem(seenKey(cardId));
  } catch {
    return null;
  }
}

function markSeen(cardId: string, at: string) {
  try {
    if (readSeen(cardId) === at) return;
    localStorage.setItem(seenKey(cardId), at);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

function subscribeSeen(cb: () => void) {
  window.addEventListener(SEEN_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(SEEN_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

const useStyles = makeStyles({
  count: { display: 'inline-flex', alignItems: 'center', ...shorthands.gap('2px') },
  countNew: { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  section: { display: 'grid', ...shorthands.gap('8px') },
  label: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground3 },
  reply: {
    display: 'grid',
    ...shorthands.gap('4px'),
    ...shorthands.padding('8px', '10px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  head: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px') },
  author: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200 },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, flexGrow: 1 },
  body: { fontSize: tokens.fontSizeBase300, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...shorthands.margin('0') },
  file: { display: 'flex', alignItems: 'center', ...shorthands.gap('6px'), fontSize: tokens.fontSizeBase200 },
  composer: { display: 'grid', ...shorthands.gap('6px') },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', ...shorthands.gap('8px') },
});

/**
 * The reply count on a card's footer. Marked "new" when the latest reply came after you last opened the card and was not yours. Renders
 * nothing when there are no replies.
 */
export function ReplyCount({ cardId, count, lastAt, lastBy, meId }: { cardId: string; count: number; lastAt: string | null; lastBy: string | null; meId: string | undefined }) {
  const s = useStyles();
  const seen = useSyncExternalStore(subscribeSeen, () => readSeen(cardId));
  if (!count) return null;
  const isNew = !!lastAt && lastBy !== meId && (!seen || new Date(lastAt).getTime() > new Date(seen).getTime());
  const what = `${count} repl${count === 1 ? 'y' : 'ies'}`;
  return (
    <span className={isNew ? `${s.count} ${s.countNew}` : s.count} title={isNew ? `${what} - new since you last opened this card` : what}>
      {' · '}
      <ChatRegular style={{ verticalAlign: 'text-bottom' }} /> {count}
      {isNew && ' new'}
    </span>
  );
}

const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The thread in a card's details: every reply oldest first, then a box to add one. */
export function CardReplies({
  path,
  cardId,
  meId,
  canManage,
  listKey,
}: {
  path: BoardPath;
  cardId: string;
  meId: string | undefined;
  /** An administrator of the board may delete any reply. */
  canManage: boolean;
  /** The board's own query key, refreshed so the card's reply count moves. */
  listKey: readonly unknown[];
}) {
  const s = useStyles();
  const qc = useQueryClient();
  const key = repliesKey(path, cardId);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: key, queryFn: () => api<BoardReply[]>(`${path}/${cardId}/replies`) });
  const replies = list.data ?? [];
  const latest = replies.length ? replies[replies.length - 1].created_at : null;

  // Opening the card counts as reading its replies.
  useEffect(() => {
    if (latest) markSeen(cardId, latest);
  }, [cardId, latest]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: listKey });
  };
  const send = useMutation({
    mutationFn: () => {
      const body = text.trim();
      if (!body) throw new ApiError(400, 'Write a reply.');
      if (file && file.size > BUG_ATTACHMENT_MAX_BYTES) throw new ApiError(400, 'That file is too large (10 MB at most).');
      const form = new FormData();
      form.append('body', body);
      if (file) form.append('file', file);
      return api<BoardReply>(`${path}/${cardId}/replies`, { method: 'POST', body: form });
    },
    onSuccess: () => {
      setText('');
      setFile(null);
      setError(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not send the reply.'),
  });
  const remove = useMutation({
    mutationFn: (r: BoardReply) => api(`${path}/${cardId}/replies/${r.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not delete the reply.'),
  });

  return (
    <div className={s.section}>
      <span className={s.label}>Replies{replies.length ? ` (${replies.length})` : ''}</span>
      {list.isLoading && <Spinner size="tiny" />}
      {list.isError && (
        <MessageBar intent="error">
          <MessageBarBody>Could not load the replies.</MessageBarBody>
        </MessageBar>
      )}
      {replies.map((r) => (
        <div key={r.id} className={s.reply}>
          <div className={s.head}>
            <span className={s.author}>{r.author_name ?? 'Unknown'}</span>
            <Text className={s.meta}>{when(r.created_at)}</Text>
            {(canManage || (!!meId && r.author_id === meId)) && (
              <Button
                size="small"
                appearance="subtle"
                icon={<DeleteRegular />}
                aria-label="Delete this reply"
                title="Delete this reply"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm('Delete this reply? Its file goes with it.')) remove.mutate(r);
                }}
              />
            )}
          </div>
          <p className={s.body}>{r.body}</p>
          {r.attachments.map((a) => (
            <div key={a.id} className={s.file}>
              <AttachRegular />
              <Link onClick={() => apiDownload(`${path}/${cardId}/attachments/${a.id}`, a.filename).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not download the file.'))}>
                {a.filename}
              </Link>
              <Text className={s.meta}>{fileSize(a.size)}</Text>
            </div>
          ))}
        </div>
      ))}
      <div className={s.composer}>
        <Textarea
          aria-label="Write a reply"
          placeholder="Answer a question or add something for the people working this card"
          resize="vertical"
          rows={3}
          value={text}
          maxLength={BOARD_REPLY_MAX_CHARS}
          onChange={(_, d) => setText(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !send.isPending) send.mutate();
          }}
        />
        <div className={s.actions}>
          <Button appearance="primary" size="small" icon={<SendRegular />} disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'Sending…' : 'Reply'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.docx,.xlsx,.pptx,.doc,.xls"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
          {file ? (
            <span className={s.file}>
              <AttachRegular /> {file.name} ({fileSize(file.size)})
              <Button size="small" appearance="subtle" icon={<DismissRegular />} aria-label="Remove the file" onClick={() => setFile(null)} />
            </span>
          ) : (
            <Button size="small" appearance="subtle" icon={<AttachRegular />} onClick={() => fileInput.current?.click()}>
              Add a file
            </Button>
          )}
        </div>
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
