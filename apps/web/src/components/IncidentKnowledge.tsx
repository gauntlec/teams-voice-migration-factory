import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Spinner, Text, Textarea, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { INC_CATEGORIES } from '@tvmf/shared';
import { api } from '../api';
import { errorText } from '../pages/ServiceRequests';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  row: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  item: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2) },
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
});

interface Snippet {
  id: string;
  title: string;
  category: string;
  subcategory: string | null;
  symptoms: string;
  fix: string;
  customer_text: string;
  helpful: number;
  not_helpful: number;
}

/** For engineers: what was learned fixing something like this before, with "this helped" feedback. Nothing renders when nothing matches. */
export function KnowledgeSuggestions({ base, incidentId }: { base: string; incidentId: string }) {
  const s = useStyles();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['incident-knowledge-for', base, incidentId], queryFn: () => api<Snippet[]>(`${base}/knowledge/for/${incidentId}`) });
  const [voted, setVoted] = useState<Record<string, boolean>>({});
  const vote = useMutation({
    mutationFn: (v: { id: string; helpful: boolean }) => api(`${base}/knowledge/${v.id}/feedback`, { method: 'POST', body: JSON.stringify({ helpful: v.helpful }) }),
    onSuccess: (_, v) => {
      setVoted((x) => ({ ...x, [v.id]: v.helpful }));
      qc.invalidateQueries({ queryKey: ['incident-knowledge'] });
    },
  });
  if (!q.data?.length) return null;
  return (
    <Card className={s.card}>
      <Text weight="semibold">Might help</Text>
      <Text size={200} className={s.muted}>
        Saved from incidents like this one that were fixed.
      </Text>
      {q.data.map((k) => (
        <div key={k.id} className={s.item}>
          <Text weight="semibold">{k.title}</Text>
          {k.symptoms && (
            <Text size={200} className={s.muted} style={{ whiteSpace: 'pre-wrap' }}>
              Seen as: {k.symptoms.slice(0, 300)}
            </Text>
          )}
          <Text style={{ whiteSpace: 'pre-wrap' }}>{k.fix}</Text>
          <div className={s.row}>
            {voted[k.id] === undefined ? (
              <>
                <Button size="small" disabled={vote.isPending} onClick={() => vote.mutate({ id: k.id, helpful: true })}>
                  This helped
                </Button>
                <Button size="small" disabled={vote.isPending} onClick={() => vote.mutate({ id: k.id, helpful: false })}>
                  Not helpful
                </Button>
              </>
            ) : (
              <Text size={200}>Thanks: {voted[k.id] ? 'noted as helpful' : 'noted as not helpful'}.</Text>
            )}
            <Text size={100} className={s.muted}>
              {k.helpful} found it helpful
            </Text>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** A tip written for customers, shown on the raise form when what they are describing matches. */
export function KnowledgeTips({ base, category, subcategory, text, enabled }: { base: string; category: string; subcategory: string; text: string; enabled: boolean }) {
  const s = useStyles();
  const q = useQuery({
    queryKey: ['incident-knowledge-tips', base, category, subcategory, text.slice(0, 200)],
    enabled: enabled && !!category,
    queryFn: () => api<{ id: string; title: string; customer_text: string }[]>(`${base}/knowledge/match?category=${category}${subcategory ? `&subcategory=${encodeURIComponent(subcategory)}` : ''}${text.trim() ? `&q=${encodeURIComponent(text.slice(0, 500))}` : ''}`),
  });
  if (!q.data?.length) return null;
  return (
    <Card className={s.card}>
      <Text weight="semibold">A quick thing to try first</Text>
      {q.data.map((k) => (
        <Text key={k.id} style={{ whiteSpace: 'pre-wrap' }}>
          {k.customer_text}
        </Text>
      ))}
      <Text size={200} className={s.muted}>
        If that does not sort it, carry on and raise the incident below.
      </Text>
    </Card>
  );
}

interface Draft {
  title: string;
  category: string;
  subcategory: string | null;
  symptoms: string;
  fix: string;
  customerText: string;
  sourceIncidentId: string | null;
}

/** Saves what fixed an incident as knowledge (engineers): starts from the incident and the note that resolved it. */
export function SaveKnowledgeButton({ base, incidentId }: { base: string; incidentId: string }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const start = useMutation({ mutationFn: () => api<Draft>(`${base}/knowledge/draft/${incidentId}`), onSuccess: (x) => (setD(x), setOpen(true)) });
  const save = useMutation({
    mutationFn: () => api(`${base}/knowledge`, { method: 'POST', body: JSON.stringify({ title: d!.title, category: d!.category, subcategory: d!.subcategory, symptoms: d!.symptoms, fix: d!.fix, customerText: d!.customerText, sourceIncidentId: d!.sourceIncidentId }) }),
    onSuccess: () => {
      setSaved(true);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['incident-knowledge'] });
    },
  });
  const set = (p: Partial<Draft>) => d && setD({ ...d, ...p });
  return (
    <>
      <Button size="small" disabled={start.isPending || saved} onClick={() => start.mutate()}>
        {saved ? 'Saved as knowledge' : 'Save as knowledge'}
      </Button>
      {start.error && <Text className={s.error}>{errorText(start.error, 'Could not start.')}</Text>}
      {open && d && (
        <Dialog open onOpenChange={(_, x) => !x.open && setOpen(false)}>
          <DialogSurface style={{ maxWidth: '720px', width: '94vw' }}>
            <DialogBody>
              <DialogTitle>Save what fixed it</DialogTitle>
              <DialogContent className={s.stack} style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                <Field label="Title" required>
                  <Input value={d.title} onChange={(_, x) => set({ title: x.value })} />
                </Field>
                <Field label="What it looked like">
                  <Textarea rows={3} value={d.symptoms} onChange={(_, x) => set({ symptoms: x.value })} />
                </Field>
                <Field label="What fixed it" required>
                  <Textarea rows={4} value={d.fix} onChange={(_, x) => set({ fix: x.value })} />
                </Field>
                <Field label="A tip for customers (optional)" hint="Shown to customers who start to raise something like this. Plain words, nothing internal. Leave empty to keep this for the team.">
                  <Textarea rows={3} value={d.customerText} onChange={(_, x) => set({ customerText: x.value })} />
                </Field>
                {save.error && <Text className={s.error}>{errorText(save.error, 'Could not save.')}</Text>}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button appearance="primary" disabled={save.isPending || d.title.trim().length < 3 || d.fix.trim().length < 3} onClick={() => save.mutate()}>
                  Save
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}

/** Everything the team has saved: read, edit the wording, take things out. */
export function KnowledgeDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Snippet | null>(null);
  const list = useQuery({ queryKey: ['incident-knowledge', base], queryFn: () => api<Snippet[]>(`${base}/knowledge`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['incident-knowledge'] });
  const save = useMutation({
    mutationFn: (k: Snippet) => api(`${base}/knowledge/${k.id}`, { method: 'PATCH', body: JSON.stringify({ title: k.title, fix: k.fix, symptoms: k.symptoms, customerText: k.customer_text }) }),
    onSuccess: () => (setEditing(null), refresh()),
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`${base}/knowledge/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const label = (k: Snippet) => INC_CATEGORIES.find((c) => c.key === k.category)?.label ?? k.category;
  return (
    <>
      {(
        <Dialog open onOpenChange={(_, x) => !x.open && onClose()}>
          <DialogSurface style={{ maxWidth: '820px', width: '94vw' }}>
            <DialogBody>
              <DialogTitle>Knowledge</DialogTitle>
              <DialogContent className={s.stack} style={{ maxHeight: '72vh', overflowY: 'auto' }}>
                <Text size={200} className={s.muted}>
                  Saved from incidents that were fixed (Save as knowledge on a resolved incident). Suggested on new incidents of the same kind, and read by assistants.
                </Text>
                {list.isLoading && <Spinner size="tiny" />}
                {list.data?.length === 0 && <Text>Nothing saved yet.</Text>}
                {list.data?.map((k) =>
                  editing?.id === k.id ? (
                    <div key={k.id} className={s.item}>
                      <Field label="Title">
                        <Input value={editing.title} onChange={(_, x) => setEditing({ ...editing, title: x.value })} />
                      </Field>
                      <Field label="What it looked like">
                        <Textarea rows={2} value={editing.symptoms} onChange={(_, x) => setEditing({ ...editing, symptoms: x.value })} />
                      </Field>
                      <Field label="What fixed it">
                        <Textarea rows={3} value={editing.fix} onChange={(_, x) => setEditing({ ...editing, fix: x.value })} />
                      </Field>
                      <Field label="Tip for customers">
                        <Textarea rows={2} value={editing.customer_text} onChange={(_, x) => setEditing({ ...editing, customer_text: x.value })} />
                      </Field>
                      <div className={s.row}>
                        <Button appearance="primary" size="small" disabled={save.isPending} onClick={() => save.mutate(editing)}>
                          Save
                        </Button>
                        <Button size="small" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div key={k.id} className={s.item}>
                      <div className={s.row}>
                        <Text weight="semibold">{k.title}</Text>
                        <Text size={200} className={s.muted}>
                          {label(k)} · {k.helpful} helped · {k.not_helpful} did not{k.customer_text ? ' · has a customer tip' : ''}
                        </Text>
                      </div>
                      <Text style={{ whiteSpace: 'pre-wrap' }}>{k.fix}</Text>
                      <div className={s.row}>
                        <Button size="small" onClick={() => setEditing(k)}>
                          Edit
                        </Button>
                        <Button size="small" disabled={remove.isPending} onClick={() => window.confirm('Take this out?') && remove.mutate(k.id)}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  ),
                )}
                {(save.error || remove.error) && <Text className={s.error}>{errorText(save.error ?? remove.error, 'That did not work.')}</Text>}
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={onClose}>
                  Close
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}
