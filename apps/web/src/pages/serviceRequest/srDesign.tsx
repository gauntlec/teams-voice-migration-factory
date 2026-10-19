import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, Spinner, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text , makeStyles, shorthands, mergeClasses } from '@fluentui/react-components';
import { SR_BUILD_KIND, SR_BUILD_KIND_LABELS, SR_ITEM_KIND_LABELS, SR_STATUS_LABELS, isSrChangeType, srDesignEditable, srHasNumbersDesign, type SrBuildDraftResult, type SrBuildKind, type SrBuildLink, type SrDesignSummary, type SrItem } from '@tvmf/shared';
import { api, setDesigningServiceRequest } from '../../api';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { BuildSiteWorkspace } from '../BuildSiteWorkspace';
import { errorText, useSrStyles, when, type RequestDetail } from '../ServiceRequests';
import { BUILD_TAB_FOR, BUILD_LIST_KEYS, usePageStyles, type RequestPayload } from './srShared';

const useLocalStyles = makeStyles({
  ml6: { marginLeft: '6px' },
  pl20Margin0: { ...shorthands.margin("0px"), paddingLeft: "20px" },
  pl20Margin02: { ...shorthands.margin("0px"), paddingLeft: '20px' },
  itemsEnd: { alignItems: "end" },
});


export function DesignTab({
  base,
  data,
  design,
  designError,
}: {
  base: string;
  data: RequestPayload;
  design: SrDesignSummary | undefined;
  designError: unknown;
}) {
  const ls = useLocalStyles();
  const ps = usePageStyles();
  const cs = useSrStyles();
  const qc = useQueryClient();
  const r = data.request;
  const editable = srDesignEditable(r.status);
  const kind = SR_BUILD_KIND[r.type];

  // While this tab is open on a Planned request, Design & Build rows created
  // below are linked to the request (see api.ts).
  useEffect(() => {
    if (!editable) return;
    setDesigningServiceRequest(r.id);
    return () => setDesigningServiceRequest(null);
  }, [editable, r.id]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['service-request', base, r.id] });
    qc.invalidateQueries({ queryKey: ['service-request-design', base, r.id] });
    for (const k of BUILD_LIST_KEYS) qc.invalidateQueries({ queryKey: [k] });
  };
  const unlink = useMutation({
    mutationFn: (item: SrItem) => api(`${base}/${r.id}/items/${item.kind}/${item.row_id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (srHasNumbersDesign(r.type)) return <NumbersDesign base={base} request={r} design={design} onDone={refresh} />;

  const lockedWhy =
    r.status === 'new'
      ? 'Mark the request as planned to start designing it.'
      : `The design is locked because the request is ${SR_STATUS_LABELS[r.status]}.`;

  return (
    <>
      <Card className={ps.card}>
        <Text weight="semibold" size={400}>
          Designed for {r.reference}
        </Text>
        <Text size={200} className={ps.muted}>
          {editable
            ? `Design the request with the same editors as Design & Build, below. Anything you add here belongs to ${r.reference}: it also shows on the site's Design & Build page, tagged ${r.reference}, and the Deploy tab deploys just these rows.`
            : lockedWhy}
        </Text>
        {designError ? <LoadError message={(designError as Error).message} /> : null}
        {!design ? (
          <Spinner size="tiny" />
        ) : design.items.length === 0 ? (
          <Text size={200}>Nothing designed yet.</Text>
        ) : (
          <DataTable size="small" minWidth={520}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {design.items.map((i) => (
                <TableRow key={`${i.kind}:${i.row_id}`}>
                  <TableCell>{SR_ITEM_KIND_LABELS[i.kind]}</TableCell>
                  <TableCell>
                    {i.label ?? (
                      <Badge appearance="tint" color="danger">
                        Deleted from Design & Build
                      </Badge>
                    )}
                    {i.label && i.site_id && r.site_id && i.site_id !== r.site_id && i.kind !== 'site' && (
                      <Badge appearance="tint" color="warning" className={ls.ml6} title="This row is on a different site from the request, so it can't be deployed from here.">
                        On another site
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {editable && (
                      <Button
                        size="small"
                        appearance="subtle"
                        disabled={unlink.isPending}
                        title="Takes the row off this request. It stays in Design & Build."
                        onClick={() => unlink.mutate(i)}
                      >
                        Remove from request
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
        {unlink.error && <Text className={cs.error}>{errorText(unlink.error, 'Could not remove the row')}</Text>}
        {design && design.builtBlockers.length === 0 && r.status === 'planned' && (
          <Text size={200}>Ready: mark the request as designed &amp; built on the Overview tab, then deploy it.</Text>
        )}
        {editable && data.build?.canDraft && data.build.kind && (
          <BuildDraftSection
            base={base}
            id={r.id}
            kind={data.build.kind}
            suggestedCapUpn={data.build.suggestedCapUpn}
            onDone={refresh}
            change={isSrChangeType(r.type)}
          />
        )}
      </Card>

      {r.status !== 'new' && r.site_id && (
        <BuildSiteWorkspace
          embedded={{
            siteId: r.site_id,
            requestId: r.id,
            reference: r.reference,
            editable,
            tab: kind ? BUILD_TAB_FOR[kind] : undefined,
            // Rows made below are linked server-side; refresh the summary above.
            onChanged: () => qc.invalidateQueries({ queryKey: ['service-request-design', base, r.id] }),
          }}
        />
      )}
    </>
  );
}

/**
 * Creates the request's main row from the customer's answers (see
 * service-request-build.ts) and links it to the request. Doesn't change the
 * request's status.
 */
export function BuildDraftSection({
  base,
  id,
  kind,
  suggestedCapUpn,
  onDone,
  change = false,
}: {
  base: string;
  id: string;
  kind: SrBuildKind;
  suggestedCapUpn: string | null;
  onDone: () => void;
  /** A change or removal: links the existing row and applies the request to it. */
  change?: boolean;
}) {
  const ls = useLocalStyles();
  const cs = useSrStyles();
  const [capUpn, setCapUpn] = useState(suggestedCapUpn ?? '');
  const draft = useMutation({
    mutationFn: () =>
      api<SrBuildDraftResult>(`${base}/${id}/build-draft`, {
        method: 'POST',
        body: JSON.stringify(kind === 'cap' ? { capUpn: capUpn.trim() } : {}),
      }),
    onSuccess: onDone,
  });
  const result = draft.data;
  const what = kind === 'site' ? 'the new site' : `the ${SR_BUILD_KIND_LABELS[kind].toLowerCase()}`;
  if (change) {
    return (
      <div className={cs.section}>
        <Text weight="semibold">Apply the request</Text>
        <Text size={200}>
          Finds the {SR_BUILD_KIND_LABELS[kind].toLowerCase()} in Design &amp; Build (adding a user to this site if they aren&apos;t there yet), adds it to this
          request, and makes the changes that can be made automatically. Anything else is listed for you to finish below.
        </Text>
        <div className={cs.actions}>
          <Button disabled={draft.isPending} onClick={() => draft.mutate()}>
            Apply the request
          </Button>
          {draft.isPending && <Spinner size="tiny" />}
        </div>
        {result && (
          <div>
            <BuildLinks links={[...result.created, ...result.existing]} />
            {result.applied && result.applied.length > 0 && <Text block>Applied: {result.applied.join('; ')}.</Text>}
            {result.applied && result.applied.length === 0 && <Text block>Nothing could be applied automatically.</Text>}
          </div>
        )}
        {result && result.warnings.length > 0 && (
          <div>
            <Text weight="semibold">Still to do</Text>
            <ul className={ls.pl20Margin0}>
              {result.warnings.map((w) => (
                <li key={w}>
                  <Text size={200}>{w}</Text>
                </li>
              ))}
            </ul>
          </div>
        )}
        {draft.error && <Text className={cs.error}>{errorText(draft.error, 'Could not apply the request')}</Text>}
      </div>
    );
  }
  return (
    <div className={cs.section}>
      <Text weight="semibold">Prefill from the request</Text>
      <Text size={200}>
        Creates {what} from the customer&apos;s answers, so you don&apos;t have to retype them{kind === 'site' ? '' : ', then finish it below (phone number, policies, routing)'}.
      </Text>
      {kind === 'cap' && (
        <Field label="Account sign-in address (UPN)" required hint="The customer isn't asked for this. Suggested from the phone's name.">
          <Input value={capUpn} onChange={(_, d) => setCapUpn(d.value)} placeholder="e.g. reception.desk@contoso.com" />
        </Field>
      )}
      <div className={cs.actions}>
        <Button disabled={draft.isPending || (kind === 'cap' && !capUpn.trim())} onClick={() => draft.mutate()}>
          {kind === 'site' ? 'Create the site' : `Prefill ${SR_BUILD_KIND_LABELS[kind].toLowerCase()}`}
        </Button>
        {draft.isPending && <Spinner size="tiny" />}
      </div>
      {result && result.created.length > 0 && (
        <div>
          <Text>Created:</Text>
          <BuildLinks links={result.created} />
        </div>
      )}
      {result && result.existing.length > 0 && (
        <div>
          <Text>Already in Design & Build, so it was added to this request unchanged:</Text>
          <BuildLinks links={result.existing} />
        </div>
      )}
      {result?.warnings.map((w) => (
        <Text key={w} className={cs.error}>
          {w}
        </Text>
      ))}
      {draft.error && <Text className={cs.error}>{errorText(draft.error, 'Could not create the row')}</Text>}
    </div>
  );
}

export function BuildLinks({ links }: { links: SrBuildLink[] }) {
  const ls = useLocalStyles();
  return (
    <ul className={ls.pl20Margin0}>
      {links.map((l) => (
        <li key={l.href + l.label}>
          <RouterLink to={l.href}>
            {SR_BUILD_KIND_LABELS[l.kind]}: {l.label}
          </RouterLink>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------- deploy --------------------------------- */

/** Design for a "new phone numbers" request: add the carrier's range to the site's inventory. */
function NumbersDesign({ base, request: r, design, onDone }: { base: string; request: RequestDetail; design: SrDesignSummary | undefined; onDone: () => void }) {
  const ls = useLocalStyles();
  const ps = usePageStyles();
  const cs = useSrStyles();
  const editable = srDesignEditable(r.status);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [carrier, setCarrier] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api<{ added: number; skipped: number }>(`${base}/${r.id}/numbers`, {
        method: 'POST',
        body: JSON.stringify({ range_start: start.trim(), range_end: (end || start).trim(), carrier: carrier.trim() || undefined }),
      }),
    onSuccess: () => {
      setStart('');
      setEnd('');
      onDone();
    },
  });
  const ranges = (design?.items ?? []).filter((i) => i.kind === 'number_range');
  return (
    <Card className={ps.card}>
      <Text weight="semibold" size={400}>
        Numbers for {r.reference}
      </Text>
      <Text size={200} className={ps.muted}>
        {editable
          ? "Once the carrier has given you the numbers, add them here. They go into the site's number inventory as free numbers, ready to give to people. There's nothing to deploy - mark the request as designed & built, then as deployed when the numbers work."
          : r.status === 'new'
            ? 'Mark the request as planned to add numbers.'
            : `Locked because the request is ${SR_STATUS_LABELS[r.status]}.`}
      </Text>
      {ranges.length > 0 ? (
        <ul className={ls.pl20Margin02}>
          {ranges.map((i) => (
            <li key={i.row_id}>
              <Text>{i.label ?? 'Range deleted from the inventory'}</Text>
            </li>
          ))}
        </ul>
      ) : (
        <Text size={200}>No numbers added yet.</Text>
      )}
      {editable && (
        <div className={mergeClasses(cs.actions, ls.itemsEnd)}>
          <Field label="First number">
            <Input value={start} placeholder="+442079460100" onChange={(_, d) => setStart(d.value)} />
          </Field>
          <Field label="Last number" hint="Leave empty for a single number.">
            <Input value={end} placeholder="+442079460199" onChange={(_, d) => setEnd(d.value)} />
          </Field>
          <Field label="Carrier">
            <Input value={carrier} onChange={(_, d) => setCarrier(d.value)} />
          </Field>
          <Button appearance="primary" disabled={!start.trim() || add.isPending} onClick={() => add.mutate()}>
            Add numbers
          </Button>
        </div>
      )}
      {add.data && (
        <Text size={200}>
          Added {add.data.added} number{add.data.added === 1 ? '' : 's'}
          {add.data.skipped ? `; ${add.data.skipped} were already in the inventory` : ''}.
        </Text>
      )}
      {add.error && <Text className={cs.error}>{errorText(add.error, 'Could not add the numbers')}</Text>}
    </Card>
  );
}

/* ------------------------------ related incidents ------------------------------ */
