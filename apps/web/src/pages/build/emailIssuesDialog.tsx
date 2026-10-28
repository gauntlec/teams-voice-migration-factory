import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  Textarea,
  Field,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { BuildIssueRecipient, BuildIssueRow, EmailBuildIssuesInput, EmailBuildIssuesResult } from '@tvmf/shared';
import { api, ApiError } from '../../api';

const useStyles = makeStyles({
  surface: { width: 'min(620px, calc(100vw - 32px))', maxWidth: '100%' },
  body: { display: 'grid', rowGap: '16px' },
  muted: { color: tokens.colorNeutralForeground3 },
  list: { display: 'grid', maxHeight: '180px', overflowY: 'auto', rowGap: '6px', padding: '10px 12px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  issue: { display: 'grid' },
  wrap: { overflowWrap: 'anywhere' },
  people: { display: 'grid', rowGap: '2px' },
});

/**
 * Email the picked validation issues to the site's contacts. Shows what will be sent and to whom (the site's Site contact(s), each
 * can be left out), takes an optional note, and says plainly what happened. Replies go to the person sending.
 */
export function EmailIssuesDialog({ base, siteId, sitecode, issues: picked, onClose, onSent }: { base: string; siteId: string; sitecode: string; issues: BuildIssueRow[]; onClose: () => void; onSent: () => void }) {
  const s = useStyles();
  // What was picked when the dialog opened; the tab clears its ticks once the email is sent, while this stays to show what went.
  const issues = useRef(picked).current;
  const [message, setMessage] = useState('');
  const [off, setOff] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<EmailBuildIssuesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recipients = useQuery({
    queryKey: ['build-issue-recipients', base, siteId],
    queryFn: () => api<BuildIssueRecipient[]>(`${base}/issues/recipients?siteId=${siteId}`),
  });
  const people = recipients.data ?? [];
  const chosen = people.filter((p) => !off.has(p.email.toLowerCase()));

  const send = useMutation({
    mutationFn: () => {
      const body: EmailBuildIssuesInput = {
        site_id: siteId,
        issues: issues.map((i) => ({ sheet: i.sheet, row_id: i.rowId, code: i.issue.code, detail: i.issue.detail })),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(chosen.length !== people.length ? { recipients: chosen.map((p) => p.email) } : {}),
      };
      return api<EmailBuildIssuesResult>(`${base}/issues/email`, { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      onSent();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The email could not be sent'),
  });

  const n = issues.length;
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Email site contacts about {n} issue{n === 1 ? '' : 's'}</DialogTitle>
          <DialogContent className={s.body}>
            {result ? (
              <MessageBar intent="success">
                <MessageBarBody>
                  Sent to {result.sent} {result.sent === 1 ? 'person' : 'people'}: {result.issues} issue{result.issues === 1 ? '' : 's'}.
                  {result.skipped > 0 ? ` ${result.skipped} ${result.skipped === 1 ? 'was' : 'were'} no longer an issue and left out.` : ''} Replies come to you.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <>
                <Text size={200} className={s.muted}>
                  The site contacts for {sitecode} get a list of these issues to resolve. They see the wording below, and replies come to you.
                </Text>

                <div className={s.list} role="list" aria-label="Issues to send">
                  {issues.map((i) => (
                    <div key={`${i.sheet}:${i.rowId}:${i.issue.code}:${i.issue.detail}`} className={s.issue} role="listitem">
                      <Text className={s.wrap}>
                        {i.displayName ? `${i.displayName} (${i.upn})` : i.upn} · <b>{i.issue.label}</b>
                      </Text>
                      <Text size={200} className={`${s.muted} ${s.wrap}`}>
                        {i.issue.detail}
                      </Text>
                    </div>
                  ))}
                </div>

                <div className={s.people}>
                  <Text weight="semibold">To</Text>
                  {recipients.isLoading ? (
                    <Spinner size="tiny" />
                  ) : recipients.isError ? (
                    <Text className={s.muted}>{(recipients.error as Error).message}</Text>
                  ) : people.length === 0 ? (
                    <MessageBar intent="warning">
                      <MessageBarBody>This site has no site contact to email. Add one under Site contact(s) on the site's Overview, then try again.</MessageBarBody>
                    </MessageBar>
                  ) : (
                    people.map((p) => (
                      <Checkbox
                        key={p.email}
                        checked={!off.has(p.email.toLowerCase())}
                        onChange={(_, d) =>
                          setOff((prev) => {
                            const next = new Set(prev);
                            if (d.checked) next.delete(p.email.toLowerCase());
                            else next.add(p.email.toLowerCase());
                            return next;
                          })
                        }
                        label={p.name ? `${p.name} · ${p.email}` : p.email}
                      />
                    ))
                  )}
                </div>

                <Field label="Add a note (optional)" hint="Shown above the list, for example what you need them to do and by when.">
                  <Textarea value={message} resize="vertical" rows={3} maxLength={2000} onChange={(_, d) => setMessage(d.value)} />
                </Field>

                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {result ? (
              <Button appearance="primary" onClick={onClose}>
                Close
              </Button>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button appearance="primary" disabled={chosen.length === 0 || send.isPending} onClick={() => send.mutate()}>
                  {send.isPending ? <Spinner size="tiny" /> : `Send to ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}`}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
