import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Text, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { INC_CATEGORIES, INC_CATEGORY_BY_KEY, INC_PROBLEM_STATUSES, INC_PROBLEM_STATUS_LABELS, type IncProblemStatus } from '@tvmf/shared';
import { api } from '../api';
import { errorText } from '../pages/ServiceRequests';

const useLocalStyles = makeStyles({
  w94vwMaxW680: { maxWidth: "680px", width: "94vw" },
});


const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, maxHeight: '68vh', overflowY: 'auto' },
  error: { color: tokens.colorPaletteRedForeground1 },
});

export interface ProblemFields {
  id?: string;
  title: string;
  description: string;
  category: string | null;
  subcategory: string | null;
  status: IncProblemStatus;
  root_cause: string;
  workaround: string;
  customer_note: string;
  owner_id: string | null;
}

/**
 * Create or edit a problem record: the cause behind one or more incidents. Once the cause is understood and
 * there is a workaround, mark it a known error and engineers see it on new incidents of the same kind (and,
 * if there's a customer note, customers see that note before raising one).
 */
export function ProblemDialog({ base, problem, prefill, incidentId, onClose, onSaved }: { base: string; problem?: ProblemFields; prefill?: Partial<ProblemFields>; incidentId?: string; onClose: () => void; onSaved: () => void }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const [d, setD] = useState<ProblemFields>(
    problem ?? { title: '', description: '', category: null, subcategory: null, status: 'investigating', root_cause: '', workaround: '', customer_note: '', owner_id: null, ...prefill },
  );
  const staff = useQuery({ queryKey: ['incident-assignees', base], queryFn: () => api<{ id: string; display_name: string }[]>(`${base}/assignees`) });
  const set = (patch: Partial<ProblemFields>) => setD((prev) => ({ ...prev, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const body = { title: d.title, description: d.description, category: d.category, subcategory: d.subcategory, status: d.status, rootCause: d.root_cause, workaround: d.workaround, customerNote: d.customer_note, ownerId: d.owner_id };
      return problem?.id ? api(`${base}/problems/${problem.id}`, { method: 'PATCH', body: JSON.stringify(body) }) : api(`${base}/problems`, { method: 'POST', body: JSON.stringify({ ...body, incidentId }) });
    },
    onSuccess: onSaved,
  });
  const cat = d.category ? INC_CATEGORY_BY_KEY[d.category] : undefined;
  const knownError = (d.status === 'known_error' || d.status === 'fix_planned') && d.workaround.trim();
  return (
    <Dialog open onOpenChange={(_, x) => !x.open && onClose()}>
      <DialogSurface className={ls.w94vwMaxW680}>
        <DialogBody>
          <DialogTitle>{problem?.id ? 'Problem' : 'New problem'}</DialogTitle>
          <DialogContent className={s.stack}>
            <Field label="Title" required hint="The cause, not the symptom: e.g. SBC certificate renewal keeps slipping.">
              <Input value={d.title} maxLength={160} onChange={(_, x) => set({ title: x.value })} />
            </Field>
            <Field label="Status">
              <Select value={d.status} onChange={(_, x) => set({ status: x.value as IncProblemStatus })}>
                {INC_PROBLEM_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {INC_PROBLEM_STATUS_LABELS[st]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner">
              <Select value={d.owner_id ?? ''} onChange={(_, x) => set({ owner_id: x.value || null })}>
                <option value="">Nobody yet</option>
                {(staff.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Kind of incident it causes" hint="Lets a known error be offered on new incidents of this kind.">
              <Select value={d.category ?? ''} onChange={(_, x) => set({ category: x.value || null, subcategory: null })}>
                <option value="">Not set</option>
                {INC_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            {cat && cat.subcategories.length > 0 && (
              <Field label="More specifically">
                <Select value={d.subcategory ?? ''} onChange={(_, x) => set({ subcategory: x.value || null })}>
                  <option value="">Any of them</option>
                  {cat.subcategories.map((sub) => (
                    <option key={sub.key} value={sub.key}>
                      {sub.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="What we know">
              <Textarea value={d.description} maxLength={4000} rows={3} resize="vertical" onChange={(_, x) => set({ description: x.value })} />
            </Field>
            <Field label="Root cause">
              <Textarea value={d.root_cause} maxLength={4000} rows={3} resize="vertical" onChange={(_, x) => set({ root_cause: x.value })} />
            </Field>
            <Field label="Workaround (for the team)" hint="How to keep the customer going until it is fixed. A known error needs one.">
              <Textarea value={d.workaround} maxLength={4000} rows={3} resize="vertical" onChange={(_, x) => set({ workaround: x.value })} />
            </Field>
            <Field label="Note for customers (optional)" hint="Shown to a customer before they raise an incident of this kind - e.g. 'Known issue: update your handset firmware.' Leave blank to say nothing.">
              <Textarea value={d.customer_note} maxLength={1000} rows={2} resize="vertical" onChange={(_, x) => set({ customer_note: x.value })} />
            </Field>
            {knownError && !d.category && <Text size={200}>Choose the kind of incident it causes, or this known error won&apos;t be offered on new incidents.</Text>}
            {save.error && <Text className={s.error}>{errorText(save.error, 'Could not save the problem')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={d.title.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
