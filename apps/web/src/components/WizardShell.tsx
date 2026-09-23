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
} from '@fluentui/react-components';

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
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <Text size={200} block style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
              Step {index + 1} of {steps.length} · {step.title}
            </Text>
            <div style={{ display: 'grid', gap: 12, minHeight: 240 }}>{step.content}</div>
            {stepError && (
              <Text block style={{ color: tokens.colorPaletteRedForeground1, marginTop: 12 }}>
                {stepError}
              </Text>
            )}
            {error && (
              <Text block style={{ color: tokens.colorPaletteRedForeground1, marginTop: 12 }}>
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
