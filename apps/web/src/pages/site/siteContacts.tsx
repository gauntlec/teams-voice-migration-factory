import { useState } from 'react';
import { Badge, Button, Dropdown, Input, Option, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { AddRegular, DismissRegular } from '@fluentui/react-icons';
import { MAX_CONTACTS_PER_ROLE, SITE_CONTACT_ROLES, contactLabel, type SiteContact, type SiteContactRole, type SiteContacts } from '@tvmf/shared';

/** A user who can be picked for a role: engineers, project managers and this customer's own users. */
export interface ContactUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
}

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', ...shorthands.gap('12px') },
  panel: {
    display: 'grid',
    alignContent: 'start',
    ...shorthands.gap('8px'),
    ...shorthands.padding('12px'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...shorthands.gap('8px') },
  person: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), minWidth: 0 },
  personText: { display: 'grid', minWidth: 0, flexGrow: 1 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  addRow: { display: 'grid', ...shorthands.gap('6px') },
  typedForm: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', ...shorthands.gap('6px'), alignItems: 'center' },
});

const ROLE_HELP: Record<SiteContactRole, string> = {
  siteContacts: "The customer's people at this site. They also receive number-port document emails.",
  providerPm: 'Project manager for this site.',
  providerEngineer: 'Engineer for this site.',
  providerPortingPm: 'Project manager for number porting at this site.',
  providerPortingEngineer: 'Engineer for number porting at this site.',
};

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
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);

  const pickedIds = new Set(list.map((c) => c.userId).filter(Boolean));
  const available = candidates.filter((u) => !pickedIds.has(u.id));
  const full = list.length >= MAX_CONTACTS_PER_ROLE;

  const addTyped = () => {
    const n = name.trim();
    const e = email.trim();
    if (!n && !e) {
      setTypedError('Type a name or an email.');
      return;
    }
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      setTypedError('That email address is not valid.');
      return;
    }
    onChange([...list, { name: n || undefined, email: e || undefined }]);
    setName('');
    setEmail('');
    setTypedError(null);
    setTyping(false);
  };

  return (
    <div className={s.panel}>
      <div>
        <div className={s.panelHead}>
          <Text weight="semibold">{label}</Text>
          {list.length > 0 && (
            <Badge appearance="tint" size="small" color="informative">
              {list.length}
            </Badge>
          )}
        </div>
        <Text size={200} className={s.muted} block>
          {help}
        </Text>
      </div>

      {list.length === 0 ? (
        <Text size={200} className={s.muted}>
          No one added yet.
        </Text>
      ) : (
        list.map((c, i) => {
          const user = c.userId ? userById.get(c.userId) : undefined;
          const shownName = contactLabel(c, user?.displayName);
          const shownEmail = c.userId ? user?.email : c.name && c.email ? c.email : undefined;
          return (
            <div key={c.userId ?? `${c.name ?? ''}|${c.email ?? ''}|${i}`} className={s.person}>
              <div className={s.personText}>
                <Text className={s.ellipsis}>{shownName}</Text>
                {shownEmail && (
                  <Text size={200} className={`${s.muted} ${s.ellipsis}`}>
                    {shownEmail}
                  </Text>
                )}
              </div>
              {!c.userId && (
                <Badge appearance="outline" size="small">
                  typed
                </Badge>
              )}
              {editable && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<DismissRegular />}
                  aria-label={`Remove ${shownName} from ${label}`}
                  onClick={() => onChange(list.filter((_, j) => j !== i))}
                />
              )}
            </div>
          );
        })
      )}

      {editable && !full && (
        <div className={s.addRow}>
          <Dropdown
            size="small"
            placeholder={available.length ? 'Add a user…' : 'No more users to add'}
            disabled={available.length === 0}
            selectedOptions={[]}
            onOptionSelect={(_, d) => d.optionValue && onChange([...list, { userId: d.optionValue }])}
          >
            {available.map((u) => (
              <Option key={u.id} value={u.id} text={u.displayName}>
                {u.displayName} · {u.role.replace(/_/g, ' ').toLowerCase()}
              </Option>
            ))}
          </Dropdown>
          {typing ? (
            <>
              <div className={s.typedForm}>
                <Input size="small" placeholder="Name" value={name} onChange={(_, d) => setName(d.value)} />
                <Input size="small" placeholder="Email" value={email} onChange={(_, d) => setEmail(d.value)} />
                <Button size="small" appearance="primary" onClick={addTyped}>
                  Add
                </Button>
              </div>
              {typedError && (
                <Text size={200} className={s.muted}>
                  {typedError}
                </Text>
              )}
            </>
          ) : (
            <div>
              <Button size="small" appearance="subtle" icon={<AddRegular />} onClick={() => setTyping(true)}>
                Add someone not in the list
              </Button>
            </div>
          )}
        </div>
      )}
      {editable && full && (
        <Text size={200} className={s.muted}>
          The most people one role can hold is {MAX_CONTACTS_PER_ROLE}.
        </Text>
      )}
    </div>
  );
}
