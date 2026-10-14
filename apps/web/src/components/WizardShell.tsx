import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Text,
  tokens,

  makeStyles,
  shorthands,
} from '@fluentui/react-components';

const useLocalStyles = makeStyles({
  maxW640: { maxWidth: '640px' },
  flexGap4Mb8: { display: "flex", ...shorthands.gap('4px'), marginBottom: '8px' },
  mb12Muted: { color: tokens.colorNeutralForeground3, marginBottom: '12px' },
  gridGap12MinH240: { display: "grid", ...shorthands.gap('12px'), minHeight: '240px' },
  mt12Danger: { color: tokens.colorPaletteRedForeground1, marginTop: '12px' },
});


export interface WizardStep {
  key: string;
  title: string;
  content: ReactNode;
  /** Returns an error message to block "Next"/"Create", or null/undefined to allow it. */
  validate?: () => string | null | undefined;
}

/**
 * Generic multi-step dialog chrome for the AA/CQ creation wizard (and any
 * future wizard added to the Data Collection site workspace's tile grid -
 * see WizardTiles.tsx). No stepper precedent existed elsewhere in this
 * codebase, so this is deliberately minimal: a step index, a progress
 * label, per-step validation gating "Next", and a final step whose button
 * reads `completeLabel` instead of "Next".
 */
export function WizardShell({
  open,
  onOpenChange,
  title,
  steps,
  onComplete,
  completing,
  completeLabel = 'Create',
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  steps: WizardStep[];
  onComplete: () => void;
  completing: boolean;
  completeLabel?: string;
  error?: string | null;
}) {
  const ls = useLocalStyles();
  const [index, setIndex] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setIndex(0);
      setStepError(null);
    }
  }, [open]);

  const step = steps[index];
  const isLast = index === steps.length - 1;

  const goNext = () => {
    const err = step.validate?.();
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    if (isLast) onComplete();
    else setIndex((i) => i + 1);
  };
  const goBack = () => {
    setStepError(null);
    setIndex((i) => Math.max(0, i - 1));
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface className={ls.maxW640}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {/* A step count alone ("Step 3 of 7") answers "where am I" but
                not "how much further" at a glance - this segmented bar is
                the same information as a quick visual read. */}
            <div className={ls.flexGap4Mb8}>
              {steps.map((s, i) => (
                <div
                  key={s.key}
                  style={{
                    height: 4,
                    flex: 1,
                    borderRadius: 2,
                    backgroundColor: i <= index ? tokens.colorBrandBackground : tokens.colorNeutralStroke2,
                  }}
                />
              ))}
            </div>
            <Text size={200} block className={ls.mb12Muted}>
              Step {index + 1} of {steps.length} · {step.title}
            </Text>
            <div className={ls.gridGap12MinH240}>{step.content}</div>
            {stepError && (
              <Text block className={ls.mt12Danger}>
                {stepError}
              </Text>
            )}
            {error && (
              <Text block className={ls.mt12Danger}>
                {error}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            {index > 0 && (
              <Button appearance="secondary" onClick={goBack} disabled={completing}>
                Back
              </Button>
            )}
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" disabled={completing}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" onClick={goNext} disabled={completing}>
              {completing ? 'Saving…' : isLast ? completeLabel : 'Next'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
