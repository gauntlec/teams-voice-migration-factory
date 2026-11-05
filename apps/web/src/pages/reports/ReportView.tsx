import { useState } from 'react';
import { Button, Card, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { figureChange, figureText, type ReportCell, type ReportDocument, type ReportSection } from '@tvmf/shared';
import { DataTable } from '../../components/DataTable';

/** Rows drawn on screen per table before "Show all"; the exports always hold every row. */
const SCREEN_ROWS = 200;

const useStyles = makeStyles({
  root: { display: 'grid', ...shorthands.gap('16px'), minWidth: 0 },
  section: { display: 'grid', ...shorthands.gap('8px'), minWidth: 0 },
  title: { fontWeight: tokens.fontWeightSemibold },
  figures: { display: 'flex', flexWrap: 'wrap', ...shorthands.gap('12px') },
  figure: {
    display: 'grid',
    alignContent: 'start',
    ...shorthands.gap('2px'),
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '160px',
    ...shorthands.padding('10px', '14px'),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
  },
  label: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
  foot: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', ...shorthands.gap('2px', '8px'), fontSize: tokens.fontSizeBase200 },
  good: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
  bad: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3 },
  // Text wraps rather than being cut off (DataTable keeps cells on one line; an inner block is its way to wrap one);
  // numbers line up on the right, headings with them.
  wrap: { whiteSpace: 'normal' },
  // A very long cell (a full PowerShell message) shows four lines; the whole text is in its tooltip and the exports.
  clamp: { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflowY: 'hidden', maxWidth: '520px' } as never,
  headline: {
    display: 'grid',
    ...shorthands.gap('4px'),
    ...shorthands.padding('14px', '18px'),
    ...shorthands.borderRadius(tokens.borderRadiusLarge),
    backgroundColor: tokens.colorBrandBackground2,
    ...shorthands.borderLeft('4px', 'solid', tokens.colorBrandStroke1),
  },
  headlineTitle: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold, letterSpacing: '-0.01em' },
  headlineBody: { fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase400, maxWidth: '90ch' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  tables: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', ...shorthands.gap('16px'), alignItems: 'start' },
  wide: { gridColumnStart: 1, gridColumnEnd: -1 },
  note: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  more: { justifySelf: 'start' },
});

const cellText = (v: ReportCell) => (v === null || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString('en-GB') : v);

/** One report, drawn from its sections (packages/shared/src/reports.ts) - the same sections the exports are made from. */
export function ReportView({ doc }: { doc: ReportDocument }) {
  const s = useStyles();
  // Small tables sit side by side; a table with more than three columns or many rows takes the full width.
  const isWide = (x: ReportSection) => x.kind === 'table' && (x.columns.length > 3 || x.rows.length > 12);
  const groups: ReportSection[][] = [];
  for (const sec of doc.sections) {
    const last = groups[groups.length - 1];
    if (sec.kind === 'table' && !isWide(sec) && last && last[0]!.kind === 'table' && !isWide(last[0]!)) last.push(sec);
    else groups.push([sec]);
  }
  return (
    <div className={s.root}>
      {groups.map((g, i) =>
        g.length > 1 || (g[0]!.kind === 'table' && !isWide(g[0]!)) ? (
          <div key={i} className={s.tables}>
            {g.map((sec, j) => (
              <Section key={j} section={sec} />
            ))}
          </div>
        ) : (
          <Section key={i} section={g[0]!} />
        ),
      )}
    </div>
  );
}

function Section({ section }: { section: ReportSection }) {
  const s = useStyles();
  const [all, setAll] = useState(false);
  if (section.kind === 'note') return <Text className={s.note}>{section.text}</Text>;
  if (section.kind === 'headline') {
    return (
      <section className={s.headline} aria-label="Summary">
        <span className={s.headlineTitle}>{section.title}</span>
        <span className={s.headlineBody}>{section.sentences.join(' ')}</span>
      </section>
    );
  }
  if (section.kind === 'figures') {
    return (
      <section className={s.section} aria-label={section.title}>
        <Text className={s.title}>{section.title}</Text>
        <div className={s.figures}>
          {section.figures.map((f) => {
            const ch = figureChange(f);
            return (
              <Card key={f.label} className={s.figure}>
                <span className={s.label}>{f.label}</span>
                <span className={s.value}>{figureText(f.value, f.unit)}</span>
                <span className={s.foot}>
                  {ch && <span className={ch.good === null ? s.muted : ch.good ? s.good : s.bad}>{ch.text}</span>}
                  {f.previous !== undefined && f.previous !== null && <span className={s.muted}>before {figureText(f.previous, f.unit)}</span>}
                  {f.note && <span className={s.muted}>{f.note}</span>}
                </span>
              </Card>
            );
          })}
        </div>
      </section>
    );
  }
  const rows = all ? section.rows : section.rows.slice(0, SCREEN_ROWS);
  const numeric = new Set(section.numeric ?? []);
  return (
    <section className={s.section} aria-label={section.title}>
      <Text className={s.title}>
        {section.title} {section.rows.length > 0 && <span className={s.muted}>({section.rows.length.toLocaleString('en-GB')})</span>}
      </Text>
      {section.rows.length === 0 ? (
        <Text size={200} className={s.muted}>
          {section.empty ?? 'Nothing to show.'}
        </Text>
      ) : (
        <DataTable size="small" minWidth={section.columns.length > 4 ? section.columns.length * 140 : 280}>
          <TableHeader>
            <TableRow>
              {section.columns.map((c, i) => (
                <TableHeaderCell key={i} className={numeric.has(i) ? s.num : undefined}>
                  {c}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {r.map((v, j) => (
                  <TableCell key={j} className={numeric.has(j) ? s.num : undefined}>
                    {numeric.has(j) ? (
                      cellText(v)
                    ) : typeof v === 'string' && v.length > 240 ? (
                      <div className={`${s.wrap} ${s.clamp}`} title={v}>
                        {v}
                      </div>
                    ) : (
                      <div className={s.wrap}>{cellText(v)}</div>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      {section.rows.length > SCREEN_ROWS && (
        <Button size="small" appearance="transparent" className={s.more} onClick={() => setAll((v) => !v)}>
          {all ? `Show the first ${SCREEN_ROWS}` : `Show all ${section.rows.length.toLocaleString('en-GB')} (the exports always hold every row)`}
        </Button>
      )}
      {section.note && <Text className={s.note}>{section.note}</Text>}
    </section>
  );
}
