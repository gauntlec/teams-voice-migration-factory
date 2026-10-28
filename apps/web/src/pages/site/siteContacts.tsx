import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  SearchBox,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, ArrowUndoRegular, DeleteRegular } from '@fluentui/react-icons';
import { MAX_CONTACTS_PER_ROLE, SITE_CONTACT_ROLES, contactLabel, type SiteContact, type SiteContactRole, type SiteContacts } from '@tvmf/shared';

/** A user who can be picked for a role: engineers, project managers and this customer's own users. */
export interface ContactUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

const useStyles = makeStyles({
  // Roomy two-up grid on a wide screen, one column on a narrow one; `min(100%, …)` so a card can never be wider than its container.
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 400px), 1fr))', gap: '16px' },
  panel: {
    display: 'grid',
    alignContent: 'start',
    rowGap: '4px',
    minWidth: 0,
    padding: '16px 20px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: '8px' },
  people: { display: 'grid', marginTop: '8px' },
  person: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: '12px',
    padding: '10px 0',
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  // Names and emails wrap rather than get cut off.
  wrap: { overflowWrap: 'anywhere' },
  personText: { display: 'grid', minWidth: 0 },
  trail: { display: 'flex', alignItems: 'center', columnGap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  empty: { padding: '12px 0 4px' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginTop: '12px' },
  undo: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: '8px',
    marginTop: '8px',
    padding: '6px 6px 6px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  // the add-person dialog
  dialog: { width: 'min(600px, calc(100vw - 32px))', maxWidth: '100%' },
  dialogBody: { display: 'grid', rowGap: '16px' },
  pickList: {
    display: 'grid',
    maxHeight: '320px',
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  pickRow: { padding: '4px 12px', borderTop: `1px solid ${tokens.colorNeutralStroke3}`, ':first-child': { borderTop: 'none' } },
  pickLabel: { display: 'grid', minWidth: 0 },
  fields: { display: 'grid', rowGap: '16px' },
});

const ROLE_HELP: Record<SiteContactRole, string> = {
  siteContacts: "The customer's people at this site. They also receive number-port document emails.",
  providerPm: 'Project manager for this site.',
  providerEngineer: 'Engineer for this site.',
  providerPortingPm: 'Project manager for number porting at this site.',
  providerPortingEngineer: 'Engineer for number porting at this site.',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roleName = (role: string) => role.replace(/_/g, ' ').toLowerCase();

/**
 * The people on a site, by role. Each role holds any number of people, each picked from the active users or typed in
 * (name and email). Read-only unless `editable`.
 */
export function SiteContactsEditor({
  value,
  onChange,
  editable,
  candidates,
  knownUsers,
}: {
  value: SiteContacts;
  onChange: (next: SiteContacts) => void;
  editable: boolean;
  candidates: ContactUser[];
  /** users already on the site, so they still show by name when the picker list is not loaded */
  knownUsers: ContactUser[];
}) {
  const s = useStyles();
  const userById = new Map([...knownUsers, ...candidates].map((u) => [u.id, u]));

  const setRole = (role: SiteContactRole, list: SiteContact[]) => onChange({ ...value, [role]: list });

  return (
    <div className={s.grid}>
      {SITE_CONTACT_ROLES.map((r) => (
        <RolePanel
          key={r.key}
          label={r.label}
          help={ROLE_HELP[r.key]}
          list={value[r.key] ?? []}
          editable={editable}
          candidates={candidates}
          userById={userById}
          onChange={(list) => setRole(r.key, list)}
        />
      ))}
    </div>
  );
}

function RolePanel({
  label,
  help,
  list,
  editable,
  candidates,
  userById,
  onChange,
}: {
  label: string;
  help: string;
  list: SiteContact[];
  editable: boolean;
  candidates: ContactUser[];
  userById: Map<string, ContactUser>;
  onChange: (list: SiteContact[]) => void;
}) {
  const s = useStyles();
  const [adding, setAdding] = useState(false);
  // The last person taken off, so a slip is one click to undo (until the next change). Nothing is saved until Save, either.
  const [removed, setRemoved] = useState<{ person: SiteContact; index: number; name: string } | null>(null);
  const full = list.length >= MAX_CONTACTS_PER_ROLE;

  const remove = (i: number, name: string) => {
    setRemoved({ person: list[i]!, index: i, name });
    onChange(list.filter((_, j) => j !== i));
  };
  const undo = () => {
    if (!removed) return;
    const next = [...list];
    next.splice(Math.min(removed.index, next.length), 0, removed.person);
    onChange(next);
    setRemoved(null);
  };

  return (
    <div className={s.panel}>
      <div className={s.panelHead}>
        <Text weight="semibold" size={400}>
          {label}
        </Text>
        {list.length > 0 && (
          <Badge appearance="tint" size="medium" color="informative" aria-label={`${list.length} ${list.length === 1 ? 'person' : 'people'}`}>
            {list.length}
          </Badge>
        )}
      </div>
      <Text size={200} className={s.muted}>
        {help}
      </Text>

      {list.length === 0 ? (
        <Text size={300} className={`${s.muted} ${s.empty}`}>
          No one added yet.
        </Text>
      ) : (
        <div className={s.people}>
          {list.map((c, i) => {
            const user = c.userId ? userById.get(c.userId) : undefined;
            const shownName = contactLabel(c, user?.displayName);
            const shownEmail = c.userId ? user?.email : c.name && c.email ? c.email : undefined;
            return (
              <div key={c.userId ?? `${c.name ?? ''}|${c.email ?? ''}|${i}`} className={s.person}>
                <Avatar name={shownName} color="colorful" size={36} aria-hidden />
                <div className={s.personText}>
                  <Text className={s.wrap}>{shownName}</Text>
                  {(shownEmail || user) && (
                    <Text size={200} className={`${s.muted} ${s.wrap}`}>
                      {[shownEmail, user ? roleName(user.role) : null].filter(Boolean).join(' · ')}
                    </Text>
                  )}
                </div>
                <div className={s.trail}>
                  {!c.userId && (
                    <Badge appearance="outline" size="small">
                      typed
                    </Badge>
                  )}
                  {editable && (
                    <Button appearance="subtle" icon={<DeleteRegular />} aria-label={`Remove ${shownName} from ${label}`} onClick={() => remove(i, shownName)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {removed && editable && (
        <div className={s.undo} role="status">
          <Text size={200}>Removed {removed.name}.</Text>
          <Button size="small" appearance="transparent" icon={<ArrowUndoRegular />} onClick={undo}>
            Undo
          </Button>
        </div>
      )}

      {editable && (
        <div className={s.footer}>
          {full ? (
            <Text size={200} className={s.muted}>
              The most people one role can hold is {MAX_CONTACTS_PER_ROLE}.
            </Text>
          ) : (
            <Button appearance="secondary" icon={<AddRegular />} onClick={() => setAdding(true)}>
              Add person
            </Button>
          )}
        </div>
      )}

      {adding && (
        <AddPersonDialog
          roleLabel={label}
          help={help}
          existing={list}
          candidates={candidates}
          userById={userById}
          onAdd={(people) => {
            setRemoved(null);
            onChange([...list, ...people]);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/**
 * Adding people to a role, in a dialog of its own rather than squeezed into the card: tick any number of users from a searchable list,
 * or type someone who is not a user. Fields are full width and large, the first one is focused, Enter adds, and a typed person can be
 * followed straight by another ("Add and add another"). Mistakes show next to the field they are about, as the person types.
 */
function AddPersonDialog({
  roleLabel,
  help,
  existing,
  candidates,
  userById,
  onAdd,
  onClose,
}: {
  roleLabel: string;
  help: string;
  existing: SiteContact[];
  candidates: ContactUser[];
  userById: Map<string, ContactUser>;
  onAdd: (people: SiteContact[]) => void;
  onClose: () => void;
}) {
  const s = useStyles();
  // `existing` is the role's list as it was when the dialog opened; people added with "Add and add another" are tracked in typedAdded.
  const opened = useRef(existing).current;
  const pickedIds = useMemo(() => new Set(opened.map((c) => c.userId).filter(Boolean)), [opened]);
  const available = useMemo(() => candidates.filter((u) => !pickedIds.has(u.id)), [candidates, pickedIds]);
  const [mode, setMode] = useState<'users' | 'typed'>(available.length ? 'users' : 'typed');
  const [search, setSearch] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState({ name: false, email: false });
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [typedAdded, setTypedAdded] = useState<SiteContact[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const slots = MAX_CONTACTS_PER_ROLE - opened.length - typedAdded.length;
  const q = search.trim().toLowerCase();
  const shown = q ? available.filter((u) => `${u.displayName} ${u.email} ${roleName(u.role)}`.toLowerCase().includes(q)) : available;

  // Focus the first field of whichever mode is showing.
  useEffect(() => {
    (mode === 'users' ? searchRef : nameRef).current?.focus();
  }, [mode]);

  const known = useMemo(
    () => new Set([...opened, ...typedAdded].map((c) => (c.userId ? userById.get(c.userId)?.email : c.email)?.toLowerCase()).filter(Boolean) as string[]),
    [opened, typedAdded, userById],
  );
  const trimmedEmail = email.trim();
  const emailError = !trimmedEmail ? null : !EMAIL.test(trimmedEmail) ? 'Enter a full email address, like name@company.com.' : known.has(trimmedEmail.toLowerCase()) ? `${trimmedEmail} is already in ${roleLabel}.` : null;
  const needsSomething = !name.trim() && !trimmedEmail;
  const typedValid = !needsSomething && !emailError && slots > 0;
  const showEmailError = !!emailError && (touched.email || trimmedEmail.includes('@'));

  const toggle = (id: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const addUsers = () => {
    onAdd([...ticked].map((userId) => ({ userId })));
    onClose();
  };
  const addTyped = (another: boolean) => {
    setTouched({ name: true, email: true });
    if (!typedValid) return;
    const p: SiteContact = { name: name.trim() || undefined, email: trimmedEmail || undefined };
    onAdd([p]);
    if (!another) {
      onClose();
      return;
    }
    setTypedAdded((prev) => [...prev, p]);
    setJustAdded(p.name || p.email || null);
    setName('');
    setEmail('');
    setTouched({ name: false, email: false });
    nameRef.current?.focus();
  };

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.dialog}>
        <DialogBody>
          <DialogTitle>Add to {roleLabel}</DialogTitle>
          <DialogContent className={s.dialogBody}>
            <Text size={200} className={s.muted}>
              {help}
            </Text>
            <TabList selectedValue={mode} onTabSelect={(_, d) => setMode(d.value as 'users' | 'typed')} size="large">
              <Tab value="users" disabled={available.length === 0}>
                From the user list
              </Tab>
              <Tab value="typed">Someone else</Tab>
            </TabList>

            {mode === 'users' ? (
              <>
                <SearchBox ref={searchRef} size="large" placeholder="Search by name or email" value={search} onChange={(_, d) => setSearch(d.value)} />
                {shown.length === 0 ? (
                  <Text className={s.muted}>{available.length === 0 ? 'Everyone is already in this role.' : `No one matches “${search}”.`}</Text>
                ) : (
                  <div className={s.pickList} role="group" aria-label="Users">
                    {shown.map((u) => (
                      <div key={u.id} className={s.pickRow}>
                        <Checkbox
                          checked={ticked.has(u.id)}
                          disabled={!ticked.has(u.id) && ticked.size >= slots}
                          onChange={(_, d) => toggle(u.id, !!d.checked)}
                          label={
                            <span className={s.pickLabel}>
                              <Text className={s.wrap}>{u.displayName}</Text>
                              <Text size={200} className={`${s.muted} ${s.wrap}`}>
                                {u.email} · {roleName(u.role)}
                              </Text>
                            </span>
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
                {ticked.size >= slots && (
                  <Text size={200} className={s.muted}>
                    The most people one role can hold is {MAX_CONTACTS_PER_ROLE}.
                  </Text>
                )}
              </>
            ) : (
              <form
                className={s.fields}
                onSubmit={(e) => {
                  e.preventDefault();
                  addTyped(false);
                }}
              >
                <Field label="Name" validationState={touched.name && needsSomething ? 'error' : 'none'} validationMessage={touched.name && needsSomething ? 'Enter a name or an email address.' : undefined}>
                  <Input ref={nameRef} size="large" value={name} autoComplete="off" onChange={(_, d) => setName(d.value)} onBlur={() => setTouched((t) => ({ ...t, name: true }))} />
                </Field>
                <Field label="Email" hint="Needed for them to get emails, such as number-port document requests." validationState={showEmailError ? 'error' : 'none'} validationMessage={showEmailError ? emailError : undefined}>
                  <Input size="large" type="email" value={email} autoComplete="off" onChange={(_, d) => setEmail(d.value)} onBlur={() => setTouched((t) => ({ ...t, email: true }))} />
                </Field>
                {/* a hidden submit so Enter adds from either field */}
                <button type="submit" hidden />
                <div aria-live="polite">
                  {justAdded && (
                    <Text size={200} className={s.muted}>
                      Added {justAdded}. Add another, or choose Done.
                    </Text>
                  )}
                </div>
              </form>
            )}
          </DialogContent>
          <DialogActions>
            {mode === 'users' ? (
              <>
                <Button appearance="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button appearance="primary" disabled={ticked.size === 0} onClick={addUsers}>
                  {ticked.size > 1 ? `Add ${ticked.size} people` : 'Add'}
                </Button>
              </>
            ) : (
              <>
                <Button appearance="secondary" onClick={onClose}>
                  {typedAdded.length ? 'Done' : 'Cancel'}
                </Button>
                <Button appearance="secondary" style={{ whiteSpace: 'nowrap', minWidth: 'max-content' }} disabled={!typedValid} onClick={() => addTyped(true)}>
                  Add and add another
                </Button>
                <Button appearance="primary" disabled={!typedValid} onClick={() => addTyped(false)}>
                  Add
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
