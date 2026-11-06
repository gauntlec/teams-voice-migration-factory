import { Button, Link, ProgressBar, Spinner, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { CheckmarkCircleRegular, DismissRegular, ErrorCircleRegular, InfoRegular, WarningRegular } from '@fluentui/react-icons';
import { isRunActive, runMessage, runsToShow, type DeploymentRunStatus, type RunMessage } from '@tvmf/shared';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', ...shorthands.gap('8px') },
  banner: { display: 'flex', flexDirection: 'column', ...shorthands.borderRadius('4px'), ...shorthands.overflow('hidden'), ...shorthands.borderWidth('1px'), ...shorthands.borderStyle('solid') },
  body: { display: 'flex', alignItems: 'flex-start', ...shorthands.gap('10px'), ...shorthands.padding('10px', '12px') },
  icon: { fontSize: '20px', flexShrink: 0, marginTop: '1px' },
  text: { display: 'flex', flexDirection: 'column', ...shorthands.gap('2px'), flexGrow: 1, minWidth: 0 },
  actions: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), flexShrink: 0 },
  progress: { backgroundColor: tokens.colorBrandBackground2, ...shorthands.borderColor(tokens.colorBrandStroke2) },
  success: { backgroundColor: tokens.colorPaletteGreenBackground1, ...shorthands.borderColor(tokens.colorPaletteGreenBorder1) },
  info: { backgroundColor: tokens.colorNeutralBackground3, ...shorthands.borderColor(tokens.colorNeutralStroke1) },
  warning: { backgroundColor: tokens.colorPaletteYellowBackground1, ...shorthands.borderColor(tokens.colorPaletteYellowBorder1) },
  error: { backgroundColor: tokens.colorPaletteRedBackground1, ...shorthands.borderColor(tokens.colorPaletteRedBorder1) },
});

const ICON: Record<Exclude<RunMessage['tone'], 'progress'>, JSX.Element> = {
  success: <CheckmarkCircleRegular color={tokens.colorPaletteGreenForeground1} />,
  info: <InfoRegular />,
  warning: <WarningRegular color={tokens.colorPaletteYellowForeground2} />,
  error: <ErrorCircleRegular color={tokens.colorPaletteRedForeground1} />,
};

/**
 * The top of a site's deployment page, on every tab: what is running right now and how the last run ended. Before this, a click on
 * Deploy or What-If showed nothing unless Run history happened to be open.
 */
export function DeploymentRunBanners({ runs, dismissed, onDismiss, onOpen }: { runs: DeploymentRunStatus[]; dismissed: ReadonlySet<string>; onDismiss: (id: string) => void; onOpen: (id: string) => void }) {
  const cs = useStyles();
  const shown = runsToShow(runs, dismissed);
  if (shown.length === 0) return null;
  return (
    <div className={cs.stack} role="status" aria-live="polite">
      {shown.map((r) => {
        const m = runMessage(r);
        const active = isRunActive(r);
        return (
          <div key={r.id} className={`${cs.banner} ${cs[m.tone]}`}>
            <div className={cs.body}>
              <span className={cs.icon}>{m.tone === 'progress' ? <Spinner size="tiny" /> : ICON[m.tone]}</span>
              <div className={cs.text}>
                <Text weight="semibold">{m.title}</Text>
                <Text size={200}>{m.detail}</Text>
              </div>
              <div className={cs.actions}>
                <Link onClick={() => onOpen(r.id)}>View changes</Link>
                {!active && <Button size="small" appearance="subtle" icon={<DismissRegular />} aria-label="Dismiss" onClick={() => onDismiss(r.id)} />}
              </div>
            </div>
            {active && <ProgressBar thickness="medium" />}
          </div>
        );
      })}
    </div>
  );
}
