import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDebounced } from '../hooks/useDebounced';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Menu,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Option,
  Radio,
  RadioGroup,
  SearchBox,
  Spinner,
  Switch,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  DeleteRegular,
  EditRegular,
  TableSettingsRegular,
} from '@fluentui/react-icons';
import { compareSorted, isCoordinateText, parseCoordinatePair, type Paginated } from '@tvmf/shared';
import { api, ApiError } from '../api';
import { DataTable } from './DataTable';
import { DangerText } from './ui';

const useLocalStyles = makeStyles({
  mb12: { marginBottom: '12px' },
  gridGap12: { display: "grid", gridTemplateColumns: "1fr 1fr", ...shorthands.gap('12px') },
  mt8Danger: { color: tokens.colorPaletteRedForeground1, marginTop: '8px' },
  gridGap4: { gridColumn: "1 / -1", display: "grid", ...shorthands.gap('4px') },
  minW200: { minWidth: '200px' },
  gridGap122: { display: "grid", ...shorthands.gap('12px') },
});


/* ------------------------------ shared bits ------------------------------ */

export function NoTenant() {
  return (
    <MessageBar intent="info">
      <MessageBarBody>Select a customer from the switcher in the header to continue.</MessageBarBody>
    </MessageBar>
  );
}
export function LoadError({ message }: { message: string }) {
  return (
    <MessageBar intent="error">
      <MessageBarBody>{message}</MessageBarBody>
    </MessageBar>
  );
}

export const yesNo = (v: unknown) => (v ? 'Yes' : 'No');

export type Row = Record<string, unknown> & { id: string };
export type Choice = { value: string; label: string };

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'ref' | 'radio' | 'string-array';
  options?: readonly string[];
  choices?: Choice[] | ((row: Row | null) => Choice[]);
  required?: boolean;
  placeholder?: string;
  default?: string;
  full?: boolean;
  /** A heading shown above this field when the previous field is in a different section (consecutive fields share one). */
  section?: string;
  /** Grey out (and stop editing) this field when the current form values make it inapplicable. */
  disabledWhen?: (values: Record<string, string>) => boolean;
}

export interface ColumnDef {
  key: string;
  label: string;
  render?: (r: Row) => ReactNode;
  /** What to sort this column by when it shows something other than the row's own `key` value. Leave out to sort by the raw value. */
  sortValue?: (r: Row) => string | number | boolean | null | undefined;
  /** Set false to stop a column being sortable (it is sortable when the rows hold a plain value to sort by). */
  sortable?: boolean;
}

/**
 * Autofill: when the user leaves `field`, call `run(value)`; any keys it returns
 * are copied into fields that are still empty, and `note` (if returned) is shown
 * under the field. Used by Data Collection to prefill from the Discovery snapshot.
 */
export interface SuggestConfig {
  field: string;
  run: (value: string) => Promise<{ values?: Record<string, string>; note?: string; found: boolean } | null>;
}

export const useRecordStyles = makeStyles({
  card: { ...shorthands.padding('14px'), display: 'grid', ...shorthands.gap('10px') },
  cardHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...shorthands.gap('8px'),
    flexWrap: 'wrap',
  },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', ...shorthands.gap('12px') },
  dialogForm: { display: 'grid', ...shorthands.gap('12px'), minWidth: '440px' },
  rowActions: { display: 'flex', ...shorthands.gap('4px'), justifyContent: 'flex-end' },
  muted: { color: tokens.colorNeutralForeground3 },
  tableTools: { display: 'flex', justifyContent: 'flex-end', ...shorthands.margin('0', '0', '4px') },
  // The row's identifier (and its checkbox) stay put while the rest of a wide grid scrolls sideways.
  stickyCheck: { position: 'sticky', left: 0, zIndex: 2, backgroundColor: tokens.colorNeutralBackground1, width: '40px', minWidth: '40px', maxWidth: '40px' },
  stickyFirst: { position: 'sticky', zIndex: 1, backgroundColor: tokens.colorNeutralBackground1, boxShadow: `inset -1px 0 0 ${tokens.colorNeutralStroke2}` },
  chips: { display: 'flex', ...shorthands.gap('6px'), flexWrap: 'wrap' },
  summary: { display: 'flex', ...shorthands.gap('16px'), flexWrap: 'wrap' },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', ...shorthands.gap('8px') },
  toolbar: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), flexWrap: 'wrap' },
});

/**
 * Turn a form's string values into a JSON payload using the field types. A
 * `key` of the form `"parent.child"` (one level only) writes into a nested
 * object on `parent` instead of a flat top-level key - e.g. Design & Build's
 * per-policy pickers (`policies.voice_routing_policy`, ...) collapse into one
 * `policies: {...}` object, matching the `build_users.policies` jsonb column.
 */
export function buildPayload(fields: FieldDef[], values: Record<string, string>) {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key] ?? '';
    const parsed =
      f.type === 'number'
        ? v === ''
          ? null
          : Number(v)
        : f.type === 'boolean'
          ? v === 'true'
          : f.type === 'ref'
            ? v || null
            : f.type === 'string-array'
              ? v
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
              : v;
    const dot = f.key.indexOf('.');
    if (dot === -1) {
      payload[f.key] = parsed;
    } else {
      const parent = f.key.slice(0, dot);
      const child = f.key.slice(dot + 1);
      if (parsed == null || parsed === '') continue; // omit unset nested values, don't null out the whole object
      payload[parent] = { ...((payload[parent] as Record<string, unknown>) ?? {}), [child]: parsed };
    }
  }
  return payload;
}

/**
 * Bulk-edit variant of buildPayload: every field starts blank (there's no
 * single row to seed from), and unlike single-row edit, a blank field must
 * never mean "clear it" - it means "leave every selected row's value alone".
 * So `v === ''` skips the field entirely, top-level included (buildPayload
 * only does that for nested keys - a top-level blank is a real "set to
 * null" for single-row edit, which would wipe every selected row's value
 * here). Bulk mode only ever sets values, never clears them - the same
 * `''` sentinel a plain Input/Combobox would produce if genuinely left
 * alone, so callers must give boolean fields a real "unchanged" option
 * (not default them to false) rather than reusing a two-state Switch.
 */
export function buildBulkPayload(fields: FieldDef[], values: Record<string, string>) {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key] ?? '';
    if (v === '') continue;
    const parsed = f.type === 'number' ? Number(v) : f.type === 'boolean' ? v === 'true' : v;
    const dot = f.key.indexOf('.');
    if (dot === -1) {
      payload[f.key] = parsed;
    } else {
      const parent = f.key.slice(0, dot);
      const child = f.key.slice(dot + 1);
      payload[parent] = { ...((payload[parent] as Record<string, unknown>) ?? {}), [child]: parsed };
    }
  }
  return payload;
}

const UNCHANGED = '__unchanged__';

/**
 * Select many rows, set a handful of fields once, apply to all of them in
 * one request - the bulk-edit flow shared by Design & Build (BuildSiteWorkspace)
 * and Data Collection (SiteWorkspace), "Bulk edit (N selected)". One
 * component so an improvement to the flow - a new field type, better
 * validation, whatever - lands in every page that uses it at once, instead
 * of drifting between copies. Deliberately not a mode of the RecordDialog
 * below: that component's blast radius is every page in the app, and the
 * semantics genuinely differ - RecordDialog seeds from one real row and a
 * blank field means "clear it"; here there's no single row to seed from, and
 * a field left alone must mean "don't touch any selected row", the opposite
 * convention (see buildBulkPayload above). A boolean field can't reuse a
 * plain two-state Switch for the same reason - it needs a real third "leave
 * unchanged" state, not a default of off.
 */
export function BulkEditDialog({
  open,
  onOpenChange,
  kindLabel,
  fields,
  count,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kindLabel: string;
  fields: FieldDef[];
  count: number;
  saving: boolean;
  error: string | null;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const ls = useLocalStyles();
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) setValues({});
  }, [open]);

  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v === UNCHANGED ? '' : v }));
  const touched = Object.values(values).some((v) => v !== '');

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            Bulk edit {kindLabel} ({count} selected)
          </DialogTitle>
          <DialogContent>
            <Text size={200} block className={ls.mb12}>
              Only the fields you set below will change. Leave a field on “— leave unchanged —” (or blank) to skip
              it - every other selected row's value for that field stays exactly as it is.
            </Text>
            <div className={ls.gridGap12}>
              {fields.map((f) => {
                const value = values[f.key] ?? '';
                const wide = f.full ? { gridColumn: '1 / -1' } : undefined;
                if (f.type === 'boolean') {
                  return (
                    <Field key={f.key} label={f.label} style={wide}>
                      <Dropdown
                        value={value === 'true' ? 'On' : value === 'false' ? 'Off' : '— leave unchanged —'}
                        selectedOptions={[value || UNCHANGED]}
                        onOptionSelect={(_, d) => set(f.key, d.optionValue ?? UNCHANGED)}
                      >
                        <Option value={UNCHANGED}>— leave unchanged —</Option>
                        <Option value="true">On</Option>
                        <Option value="false">Off</Option>
                      </Dropdown>
                    </Field>
                  );
                }
                if (f.type === 'select' || f.type === 'ref' || f.type === 'radio') {
                  const choices: Choice[] =
                    f.type === 'ref'
                      ? typeof f.choices === 'function'
                        ? f.choices(null)
                        : (f.choices ?? [])
                      : (f.options ?? []).map((o) => ({ value: o, label: o }));
                  return (
                    <Field key={f.key} label={f.label} style={wide}>
                      <Dropdown
                        value={choices.find((c) => c.value === value)?.label ?? '— leave unchanged —'}
                        selectedOptions={[value || UNCHANGED]}
                        onOptionSelect={(_, d) => set(f.key, d.optionValue ?? UNCHANGED)}
                      >
                        <Option value={UNCHANGED}>— leave unchanged —</Option>
                        {choices.map((c) => (
                          <Option key={c.value} value={c.value} text={c.label}>
                            {c.label}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  );
                }
                if (f.type === 'textarea') {
                  return (
                    <Field key={f.key} label={f.label} style={wide}>
                      <Textarea
                        value={value}
                        placeholder="Leave blank to skip"
                        onChange={(_, d) => set(f.key, d.value)}
                      />
                    </Field>
                  );
                }
                return (
                  <Field key={f.key} label={f.label} style={wide}>
                    <Input value={value} placeholder="Leave blank to skip" onChange={(_, d) => set(f.key, d.value)} />
                  </Field>
                );
              })}
            </div>
            {error && (
              <Text block className={ls.mt8Danger}>
                {error}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={saving || !touched || count === 0}
              onClick={() => onSave(buildBulkPayload(fields, values))}
            >
              {saving ? 'Applying…' : `Apply to ${count} row${count === 1 ? '' : 's'}`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ---------------------------- the add/edit modal ---------------------------- */

export interface GeocodeConfig {
  /** field key holding the street address to look up */
  addressField: string;
  /** field keys the result is written into */
  latField: string;
  lonField: string;
  /** returns coordinates for an address, or null if none found */
  run: (
    address: string,
  ) => Promise<{ latitude: number; longitude: number; label?: string; approximate?: boolean } | null>;
}

export function RecordDialog({
  open,
  onOpenChange,
  title,
  fields,
  editing,
  saving,
  error,
  onSave,
  geocode,
  suggest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  fields: FieldDef[];
  editing: Row | null;
  saving: boolean;
  error: string | null;
  onSave: (payload: Record<string, unknown>) => void;
  geocode?: GeocodeConfig;
  suggest?: SuggestConfig;
}) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const [values, setValues] = useState<Record<string, string>>({});
  const [geoBusy, setGeoBusy] = useState(false);
  const isCoordinateField = (key: string) => !!geocode && (key === geocode.latField || key === geocode.lonField);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [suggestMsg, setSuggestMsg] = useState<{ text: string; found: boolean } | null>(null);

  const runSuggest = async (value: string) => {
    if (!suggest || !value.trim()) return;
    try {
      const hit = await suggest.run(value.trim());
      if (!hit) {
        setSuggestMsg(null);
        return;
      }
      if (hit.values) {
        setValues((v) => {
          const next = { ...v };
          for (const [k, val] of Object.entries(hit.values!)) {
            if (!next[k] && val) next[k] = val;
          }
          return next;
        });
      }
      setSuggestMsg(hit.note ? { text: hit.note, found: hit.found } : null);
    } catch {
      setSuggestMsg(null);
    }
  };

  const runGeocode = async () => {
    if (!geocode) return;
    const addr = (values[geocode.addressField] ?? '').trim();
    if (!addr) {
      setGeoMsg('Enter the address first.');
      return;
    }
    setGeoBusy(true);
    setGeoMsg(null);
    try {
      const hit = await geocode.run(addr);
      if (!hit) {
        setGeoMsg('No coordinates found for that address — check the spelling of the street and town, or enter them manually.');
      } else {
        setValues((v) => ({
          ...v,
          [geocode.latField]: String(hit.latitude),
          [geocode.lonField]: String(hit.longitude),
        }));
        const where = hit.label ?? `${hit.latitude}, ${hit.longitude}`;
        setGeoMsg(
          hit.approximate
            ? `Approximate (area only): ${where}. Adjust if you have the exact spot.`
            : `Matched ${where}`,
        );
      }
    } catch {
      setGeoMsg('Lookup failed — enter coordinates manually.');
    } finally {
      setGeoBusy(false);
    }
  };

  const initial = useMemo(
    () => (r: Row | null) =>
      Object.fromEntries(
        fields.map((f) => {
          if (!r) return [f.key, f.default ?? (f.type === 'boolean' ? 'false' : '')];
          // "parent.child" reads the nested value (see buildPayload) so an
          // existing jsonb sub-field like `policies.calling_policy` prefills
          // correctly instead of always showing blank on Edit.
          const dot = f.key.indexOf('.');
          const v =
            dot === -1 ? r[f.key] : (r[f.key.slice(0, dot)] as Record<string, unknown> | null | undefined)?.[f.key.slice(dot + 1)];
          if (f.type === 'boolean')
            return [f.key, v === true ? 'true' : v === false ? 'false' : (f.default ?? 'false')];
          if (f.type === 'string-array') return [f.key, Array.isArray(v) ? v.join('\n') : ''];
          return [f.key, v == null ? '' : String(v)];
        }),
      ),
    [fields],
  );

  useEffect(() => {
    if (open) {
      setValues(initial(editing));
      setGeoMsg(null);
      setSuggestMsg(null);
    }
  }, [open, editing, initial]);

  const resolveChoices = (f: FieldDef): Choice[] =>
    typeof f.choices === 'function' ? f.choices(editing) : (f.choices ?? []);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            {editing ? 'Edit' : 'Add'} {title.replace(/s$/, '').toLowerCase()}
          </DialogTitle>
          <DialogContent>
            <div className={s.dialogForm}>
              {fields.map((f, fi) => {
                const disabled = f.disabledWhen?.(values) ?? false;
                return (
                <Fragment key={f.key}>
                {f.section && f.section !== fields[fi - 1]?.section && (
                  <Text weight="semibold" style={{ gridColumn: '1 / -1', paddingTop: 6 }}>
                    {f.section}
                  </Text>
                )}
                <Field
                  label={f.label}
                  required={f.required}
                  style={f.full ? { gridColumn: '1 / -1' } : undefined}
                >
                  {f.type === 'boolean' ? (
                    <Switch
                      checked={values[f.key] === 'true'}
                      disabled={disabled}
                      onChange={(_, d) =>
                        setValues((v) => ({ ...v, [f.key]: d.checked ? 'true' : 'false' }))
                      }
                    />
                  ) : f.type === 'radio' ? (
                    <RadioGroup
                      layout="horizontal"
                      disabled={disabled}
                      value={values[f.key] ?? ''}
                      onChange={(_, d) => setValues((v) => ({ ...v, [f.key]: d.value }))}
                    >
                      {(f.options ?? []).map((o) => (
                        <Radio key={o} value={o} label={o} />
                      ))}
                    </RadioGroup>
                  ) : f.type === 'textarea' || f.type === 'string-array' ? (
                    <Textarea
                      value={values[f.key] ?? ''}
                      resize="vertical"
                      disabled={disabled}
                      placeholder={f.type === 'string-array' ? f.placeholder : undefined}
                      onChange={(_, d) => setValues((v) => ({ ...v, [f.key]: d.value }))}
                    />
                  ) : f.type === 'select' || f.type === 'ref' ? (
                    <Dropdown
                      placeholder="Select…"
                      disabled={disabled}
                      selectedOptions={values[f.key] ? [values[f.key]!] : []}
                      value={
                        f.type === 'ref'
                          ? (resolveChoices(f).find((c) => c.value === values[f.key])?.label ?? '')
                          : (values[f.key] ?? '')
                      }
                      onOptionSelect={(_, d) => setValues((v) => ({ ...v, [f.key]: d.optionValue ?? '' }))}
                    >
                      {(f.type === 'ref'
                        ? [{ value: '', label: '— none —' }, ...resolveChoices(f)]
                        : (f.options ?? []).map((o) => ({ value: o, label: o }))
                      ).map((o) => (
                        <Option key={o.value || '__none'} value={o.value} text={o.label}>
                          {o.label}
                        </Option>
                      ))}
                    </Dropdown>
                  ) : (
                    <Input
                      // A browser's number box strips the comma and dot out of pasted text, so the coordinate boxes are text
                      // boxes that take "lat, long" pasted from a map site (split across both boxes) or one number at a time.
                      type={f.type === 'number' && !isCoordinateField(f.key) ? 'number' : 'text'}
                      inputMode={isCoordinateField(f.key) ? 'decimal' : undefined}
                      placeholder={f.placeholder}
                      value={values[f.key] ?? ''}
                      disabled={disabled}
                      onPaste={
                        geocode && isCoordinateField(f.key)
                          ? (e) => {
                              const pair = parseCoordinatePair(e.clipboardData.getData('text'));
                              if (!pair) return;
                              e.preventDefault();
                              setValues((v) => ({ ...v, [geocode.latField]: pair.latitude, [geocode.lonField]: pair.longitude }));
                            }
                          : undefined
                      }
                      onChange={(_, d) => {
                        if (isCoordinateField(f.key) && !isCoordinateText(d.value)) return;
                        setValues((v) => ({ ...v, [f.key]: d.value }));
                      }}
                      onBlur={
                        suggest && f.key === suggest.field
                          ? (e) => void runSuggest(e.currentTarget.value)
                          : undefined
                      }
                    />
                  )}
                </Field>
                {suggest && f.key === suggest.field && suggestMsg && (
                  <Text
                    size={200}
                    style={{
                      gridColumn: '1 / -1',
                      marginTop: -6,
                      color: suggestMsg.found
                        ? tokens.colorPaletteGreenForeground2
                        : tokens.colorNeutralForeground3,
                    }}
                  >
                    {suggestMsg.text}
                  </Text>
                )}
                {geocode && f.key === geocode.addressField && (
                  <div className={ls.gridGap4}>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={geoBusy}
                      onClick={() => void runGeocode()}
                    >
                      {geoBusy ? <Spinner size="tiny" /> : 'Get coordinates from address'}
                    </Button>
                    {geoMsg && (
                      <Text size={200} className={s.muted}>
                        {geoMsg}
                      </Text>
                    )}
                  </div>
                )}
                </Fragment>
                );
              })}
              {error && <DangerText>{error}</DangerText>}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={saving || fields.some((f) => f.required && !f.disabledWhen?.(values) && !values[f.key])}
              onClick={() => onSave(buildPayload(fields, values))}
            >
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------ client-side CRUD section ------------------------ */
/** For small, fully-loaded lists (calling policies, sites). Rows are supplied. */
export function CrudSection({
  title,
  hint,
  fields,
  rows,
  columns,
  basePath,
  readOnly,
  onChanged,
  extraRowAction,
  geocode,
}: {
  title: string;
  hint?: string;
  fields: FieldDef[];
  rows: Row[];
  columns: ColumnDef[];
  basePath: string;
  readOnly: boolean;
  onChanged: () => void;
  extraRowAction?: (r: Row) => ReactNode;
  geocode?: GeocodeConfig;
}) {
  const s = useRecordStyles();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      editing
        ? api(`${basePath}/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : api(basePath, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      setOpen(false);
      onChanged();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => onChanged(),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">
            {title} <span className={s.muted}>({rows.length})</span>
          </Text>
          {hint && (
            <Text size={200} className={s.muted} block>
              {hint}
            </Text>
          )}
        </div>
        {!readOnly && (
          <Button
            size="small"
            icon={<AddRegular />}
            onClick={() => {
              setEditing(null);
              setError(null);
              setOpen(true);
            }}
          >
            Add
          </Button>
        )}
      </div>

      {error && <LoadError message={error} />}

      {rows.length === 0 ? (
        <Text size={200} className={s.muted}>
          Nothing captured yet.
        </Text>
      ) : (
        <RecordTable
          tableId={title}
          rows={rows}
          columns={columns}
          readOnly={readOnly}
          removing={remove.isPending}
          extraRowAction={extraRowAction}
          onEdit={(r) => {
            setEditing(r);
            setError(null);
            setOpen(true);
          }}
          onDelete={(id) => remove.mutate(id)}
        />
      )}

      <RecordDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        fields={fields}
        editing={editing}
        saving={save.isPending}
        error={error}
        onSave={(payload) => save.mutate(payload)}
        geocode={geocode}
      />
    </Card>
  );
}

/* --------------------- server-paginated CRUD section --------------------- */
/**
 * For lists that grow with scale (users, numbers, ...). Fetches one page at a
 * time from `endpoint` with `?siteId=&q=&page=&limit=`; create posts to
 * `endpoint` (merging `fixed`), edit/delete hit `endpoint/:id`.
 */
export function PagedSection({
  title,
  hint,
  endpoint,
  queryKey,
  params,
  fixed,
  fields,
  columns,
  readOnly,
  onChanged,
  extraRowAction,
  headerActions,
  emptyText = 'Nothing captured yet.',
  pageSize = 50,
  suggest,
  selectable,
  selected,
  onSelectedChange,
  onEditRow,
  bulkDelete,
}: {
  title: string;
  hint?: string;
  endpoint: string;
  queryKey: unknown[];
  params?: Record<string, string | undefined>;
  fixed?: Record<string, unknown>;
  fields: FieldDef[];
  columns: ColumnDef[];
  readOnly: boolean;
  onChanged?: () => void;
  extraRowAction?: (r: Row) => ReactNode;
  /** extra buttons in the section toolbar, left of Add (e.g. bulk actions) */
  headerActions?: ReactNode;
  emptyText?: string;
  pageSize?: number;
  suggest?: SuggestConfig;
  /** Opt-in row-selection checkboxes (e.g. for a bulk-edit flow) - omit all three to leave the table exactly as before. */
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  /**
   * Intercepts the row's Edit click before the generic RecordDialog opens -
   * return true to say "I've handled this row myself" (e.g. opened a
   * bespoke editor for it) and skip the generic dialog entirely; return
   * false/undefined to fall through to the normal edit-in-place dialog.
   * Lets one row type in a list (e.g. a wizard-captured Call flow) open a
   * completely different editor without changing this component's default
   * behavior for every other caller.
   */
  onEditRow?: (r: Row) => boolean;
  /**
   * Opt-in "Delete selected" / "Delete all…" for this list, via
   * POST {endpoint}/bulk-delete ({ ids } or { site_id, all: true }; site_id
   * comes from `fixed`). Adds row checkboxes if the caller doesn't manage
   * selection itself. `note` says what else happens (e.g. numbers freed).
   */
  bulkDelete?: { noun: string; plural: string; note?: string };
}) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const qc = useQueryClient();
  // Selection: the caller's (bulk edit) if it has one, otherwise our own for bulk delete.
  const [ownSelected, setOwnSelected] = useState<Set<string>>(new Set());
  const sel = selected ?? ownSelected;
  const setSel = onSelectedChange ?? setOwnSelected;
  const canSelect = selectable ?? (!!bulkDelete && !readOnly);
  const [confirmDelete, setConfirmDelete] = useState<'selected' | 'all' | null>(null);
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [q]);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) qs.set(k, v);
  if (q) qs.set('q', q);
  qs.set('page', String(page));
  qs.set('limit', String(pageSize));

  const list = useQuery({
    queryKey: [...queryKey, params, q, page, pageSize],
    queryFn: () => api<Paginated<Row>>(`${endpoint}?${qs.toString()}`),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey });
    onChanged?.();
  };
  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      editing
        ? api(`${endpoint}/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : api(endpoint, { method: 'POST', body: JSON.stringify({ ...fixed, ...payload }) }),
    onSuccess: () => {
      setOpen(false);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${endpoint}/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Delete failed'),
  });
  const removeMany = useMutation({
    mutationFn: (which: 'selected' | 'all') =>
      api<{ deleted: number }>(`${endpoint}/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify(which === 'all' ? { site_id: fixed?.site_id, all: true } : { ids: [...sel] }),
      }),
    onSuccess: () => {
      setConfirmDelete(null);
      setSel(new Set());
      setPage(1);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const items = (list.data?.items ?? []) as Row[];

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">
            {title} <span className={s.muted}>({total})</span>
          </Text>
          {hint && (
            <Text size={200} className={s.muted} block>
              {hint}
            </Text>
          )}
        </div>
        <div className={s.toolbar}>
          <SearchBox
            size="small"
            placeholder="Search…"
            value={qInput}
            onChange={(_, d) => setQInput(d.value)}
            className={ls.minW200}
          />
          {headerActions}
          {bulkDelete && !readOnly && sel.size > 0 && (
            <Button size="small" icon={<DeleteRegular />} onClick={() => setConfirmDelete('selected')}>
              Delete selected ({sel.size})
            </Button>
          )}
          {bulkDelete && !readOnly && !!fixed?.site_id && total > 0 && (
            <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => setConfirmDelete('all')}>
              Delete all…
            </Button>
          )}
          {!readOnly && (
            <Button
              size="small"
              icon={<AddRegular />}
              onClick={() => {
                setEditing(null);
                setError(null);
                setOpen(true);
              }}
            >
              Add
            </Button>
          )}
        </div>
      </div>

      {error && <LoadError message={error} />}
      {list.isError && <LoadError message={(list.error as Error).message} />}

      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : items.length === 0 ? (
        <Text size={200} className={s.muted}>
          {q ? 'No matches.' : emptyText}
        </Text>
      ) : (
        <>
          <RecordTable
            tableId={title}
            rows={items}
            columns={columns}
            readOnly={readOnly}
            removing={remove.isPending}
            extraRowAction={extraRowAction}
            onEdit={(r) => {
              if (onEditRow?.(r)) return;
              setEditing(r);
              setError(null);
              setOpen(true);
            }}
            onDelete={(id) => remove.mutate(id)}
            selectable={canSelect}
            selected={sel}
            onSelectedChange={setSel}
          />
          {pages > 1 && (
            <div className={s.pager}>
              <Text size={200} className={s.muted}>
                Page {page} of {pages} · {total} total
              </Text>
              <Button
                size="small"
                appearance="subtle"
                icon={<ChevronLeftRegular />}
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              />
              <Button
                size="small"
                appearance="subtle"
                icon={<ChevronRightRegular />}
                disabled={page >= pages || list.isFetching}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              />
            </div>
          )}
        </>
      )}

      {bulkDelete && confirmDelete && (
        <BulkDeleteDialog
          what={confirmDelete}
          count={confirmDelete === 'all' ? total : sel.size}
          noun={bulkDelete.noun}
          plural={bulkDelete.plural}
          note={bulkDelete.note}
          busy={removeMany.isPending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => removeMany.mutate(confirmDelete)}
        />
      )}

      <RecordDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        fields={fields}
        editing={editing}
        saving={save.isPending}
        error={error}
        onSave={(payload) => save.mutate(payload)}
        suggest={suggest}
      />
    </Card>
  );
}

/**
 * Confirms a bulk delete. Deleting everything asks for the word DELETE, since
 * it can't be undone and is easy to click by mistake.
 */
function BulkDeleteDialog({
  what,
  count,
  noun,
  plural,
  note,
  busy,
  onCancel,
  onConfirm,
}: {
  what: 'selected' | 'all';
  count: number;
  noun: string;
  plural: string;
  note?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ls = useLocalStyles();
  const [typed, setTyped] = useState('');
  const label = `${count.toLocaleString()} ${count === 1 ? noun : plural}`;
  const needsWord = what === 'all';
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && !busy && onCancel()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{what === 'all' ? `Delete all ${plural} on this site?` : `Delete ${label}?`}</DialogTitle>
          <DialogContent>
            <div className={ls.gridGap122}>
              <Text>
                {what === 'all' ? `All ${label} will be deleted.` : `The ${label} you selected will be deleted.`} This can't be undone.
              </Text>
              {note && <Text size={200}>{note}</Text>}
              {needsWord && (
                <Field label="Type DELETE to confirm">
                  <Input value={typed} onChange={(_, d) => setTyped(d.value)} autoFocus />
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={busy || (needsWord && typed.trim() !== 'DELETE')} onClick={onConfirm}>
              {busy ? 'Deleting…' : `Delete ${label}`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------ the table ------------------------------ */

/** The value a column sorts by: its own `sortValue`, or the row's plain value for it. */
function sortValueOf(c: ColumnDef, r: Row): string | number | boolean | null | undefined {
  if (c.sortValue) return c.sortValue(r);
  const v = r[c.key];
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
}
const columnSortable = (c: ColumnDef, rows: Row[]) => c.sortable !== false && rows.some((r) => sortValueOf(c, r) != null);
/** Which columns a person has hidden on a table, remembered in this browser (the first column, the identifier, is always shown). */
function useColumnPrefs(tableId: string | undefined, columns: ColumnDef[]) {
  const storageKey = tableId ? `voxshift.columns.${tableId}` : null;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    if (!storageKey) return new Set();
    try {
      const raw = localStorage.getItem(storageKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const known = new Set(columns.map((c) => c.key));
  const hiddenKeys = new Set([...hidden].filter((k) => known.has(k) && k !== columns[0]?.key));
  const visible = columns.filter((c) => !hiddenKeys.has(c.key));
  const setVisibleKeys = (keys: string[]) => {
    const next = new Set(columns.filter((c, i) => i !== 0 && !keys.includes(c.key)).map((c) => c.key));
    setHidden(next);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* storage blocked: the choice lasts until reload */
      }
    }
  };
  return { visible, hiddenKeys, setVisibleKeys };
}

function RecordTable({
  tableId,
  rows,
  columns,
  readOnly,
  removing,
  extraRowAction,
  onEdit,
  onDelete,
  selectable,
  selected,
  onSelectedChange,
}: {
  /** Names this table for remembering which columns a person hid. */
  tableId?: string;
  rows: Row[];
  columns: ColumnDef[];
  readOnly: boolean;
  removing: boolean;
  extraRowAction?: (r: Row) => ReactNode;
  onEdit: (r: Row) => void;
  onDelete: (id: string) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
}) {
  const s = useRecordStyles();
  // Delete asks once, in the row itself - a stray click used to remove the row (and free its number) outright.
  const [confirming, setConfirming] = useState<string | null>(null);
  const { visible, hiddenKeys, setVisibleKeys } = useColumnPrefs(tableId, columns);
  const [sort, setSort] = useState<{ key: string; dir: 'ascending' | 'descending' } | null>(null);
  const sortedRows = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!sort || !col) return rows;
    const sign = sort.dir === 'ascending' ? (1 as const) : (-1 as const);
    return [...rows].sort((a, b) => compareSorted(sortValueOf(col, a), sortValueOf(col, b), sign));
  }, [rows, columns, sort]);
  const stickyIdentifier = columns.length >= 6;
  const minWidth = Math.max(560, visible.length * 132 + (readOnly ? 0 : 96) + (selectable ? 40 : 0));
  const allOnPageSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(r.id));
  const someOnPageSelected = selectable && rows.some((r) => selected?.has(r.id));
  const toggleAll = () => {
    if (!onSelectedChange) return;
    const next = new Set(selected);
    if (allOnPageSelected) for (const r of rows) next.delete(r.id);
    else for (const r of rows) next.add(r.id);
    onSelectedChange(next);
  };
  const toggleOne = (id: string) => {
    if (!onSelectedChange) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };
  return (
    <>
      {columns.length > 6 && (
        <div className={s.tableTools}>
          <Menu
            checkedValues={{ columns: visible.map((c) => c.key) }}
            onCheckedValueChange={(_, d) => setVisibleKeys(d.checkedItems)}
          >
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<TableSettingsRegular />}>
                Columns{hiddenKeys.size > 0 ? ` (${columns.length - hiddenKeys.size} of ${columns.length})` : ''}
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {columns.map((c, i) => (
                  <MenuItemCheckbox key={c.key} name="columns" value={c.key} disabled={i === 0}>
                    {c.label}
                  </MenuItemCheckbox>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      )}
    <DataTable size="small" minWidth={minWidth}>
      <TableHeader>
        <TableRow>
          {selectable && (
            <TableHeaderCell className={stickyIdentifier ? s.stickyCheck : undefined}>
              <Checkbox
                checked={allOnPageSelected ? true : someOnPageSelected ? 'mixed' : false}
                onChange={toggleAll}
                aria-label="Select all rows on this page"
              />
            </TableHeaderCell>
          )}
          {visible.map((c, i) => {
            const canSort = columnSortable(c, rows);
            const dir = sort?.key === c.key ? sort.dir : undefined;
            return (
              <TableHeaderCell
                key={c.key}
                className={stickyIdentifier && i === 0 ? s.stickyFirst : undefined}
                style={stickyIdentifier && i === 0 ? { left: selectable ? 40 : 0 } : undefined}
                sortable={canSort}
                sortDirection={dir}
                onClick={canSort ? () => setSort(dir === 'ascending' ? { key: c.key, dir: 'descending' } : dir === 'descending' ? null : { key: c.key, dir: 'ascending' }) : undefined}
                title={canSort ? 'Sorts the rows on this page' : undefined}
              >
                {c.label}
              </TableHeaderCell>
            );
          })}
          {!readOnly && <TableHeaderCell />}
        </TableRow>
      </TableHeader>
      <TableBody>
          {sortedRows.map((r) => (
            <TableRow key={r.id}>
              {selectable && (
                <TableCell className={stickyIdentifier ? s.stickyCheck : undefined}>
                  <Checkbox
                    checked={selected?.has(r.id) ?? false}
                    onChange={() => toggleOne(r.id)}
                    aria-label={`Select row ${r.id}`}
                  />
                </TableCell>
              )}
              {visible.map((c, i) => {
                const content = c.render ? c.render(r) : ((r[c.key] as string) ?? '—') || '—';
                return (
                  <TableCell
                    key={c.key}
                    className={stickyIdentifier && i === 0 ? s.stickyFirst : undefined}
                    style={stickyIdentifier && i === 0 ? { left: selectable ? 40 : 0 } : undefined}
                    title={typeof content === 'string' ? content : undefined}
                  >
                    {content}
                  </TableCell>
                );
              })}
              {!readOnly && (
                <TableCell>
                  {confirming === r.id ? (
                    <div className={s.rowActions}>
                      <Button
                        size="small"
                        appearance="primary"
                        disabled={removing}
                        onClick={() => {
                          setConfirming(null);
                          onDelete(r.id);
                        }}
                      >
                        Delete
                      </Button>
                      <Button size="small" appearance="subtle" onClick={() => setConfirming(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <div className={s.rowActions}>
                      {extraRowAction?.(r)}
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<EditRegular />}
                        aria-label="Edit"
                        onClick={() => onEdit(r)}
                      />
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<DeleteRegular />}
                        aria-label="Delete"
                        disabled={removing}
                        onClick={() => setConfirming(r.id)}
                      />
                    </div>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
      </TableBody>
    </DataTable>
    </>
  );
}
