import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ChevronLeftRegular, ChevronRightRegular, DismissRegular, PauseRegular, PlayRegular } from '@fluentui/react-icons';
import type { Permission } from '@tvmf/shared';
import { Overview } from './Overview';
import { AllCustomers } from './AllCustomers';

/** How long each slide shows before the next, when cycling. */
const SLIDE_MS = 20_000;

const useStyles = makeStyles({
  stage: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
  },
  bar: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
    ...shorthands.padding('10px', '24px'),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
  },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400 },
  spacer: { flexGrow: 1 },
  counter: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  // Larger type for a meeting-room screen: the whole slide is drawn a size up.
  body: { overflowY: 'auto', ...shorthands.padding('24px', '32px'), zoom: 1.2 } as never,
  progress: { position: 'absolute', left: 0, bottom: 0, height: '3px', backgroundColor: tokens.colorCompoundBrandBackground },
});

export interface Slide {
  key: string;
  title: string;
  /** a customer's Overview, or (null) the All customers view */
  tenantId: string | null;
}

/**
 * Present mode (docs/INSIGHTS.md, step 5): the Overview - or every customer in turn - full screen and a size up, for a
 * meeting-room screen. Arrow keys move, space pauses, Esc leaves. A customer's slide is its live Overview.
 */
export function Presenter({ slides, can, onClose }: { slides: Slide[]; can: (p: Permission) => boolean; onClose: () => void }) {
  const s = useStyles();
  const ref = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(slides.length > 1);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const go = useCallback((n: number) => {
    setI((v) => (v + n + slides.length) % slides.length);
    setStartedAt(Date.now());
  }, [slides.length]);

  // Full screen where the browser allows it; the overlay works without it.
  useEffect(() => {
    const el = ref.current;
    el?.requestFullscreen?.().catch(() => undefined);
    const left = () => !document.fullscreenElement && onClose();
    document.addEventListener('fullscreenchange', left);
    return () => {
      document.removeEventListener('fullscreenchange', left);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
        setStartedAt(Date.now());
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [go, onClose]);

  useEffect(() => {
    if (!playing || slides.length < 2) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - startedAt >= SLIDE_MS) go(1);
    }, 250);
    return () => clearInterval(t);
  }, [playing, startedAt, go, slides.length]);

  const slide = slides[i]!;
  const elapsed = playing && slides.length > 1 ? Math.min(1, (now - startedAt) / SLIDE_MS) : 0;
  return (
    <div ref={ref} className={s.stage} role="dialog" aria-modal="true" aria-label={`Presenting ${slide.title}`}>
      <div className={s.bar}>
        <span className={s.title}>{slide.title}</span>
        <span className={s.spacer} />
        {slides.length > 1 && (
          <>
            <Text className={s.counter}>
              {i + 1} of {slides.length}
            </Text>
            <Button appearance="subtle" icon={<ChevronLeftRegular />} aria-label="Previous" onClick={() => go(-1)} />
            <Button appearance="subtle" icon={playing ? <PauseRegular /> : <PlayRegular />} aria-label={playing ? 'Pause' : 'Play'} onClick={() => (setPlaying((p) => !p), setStartedAt(Date.now()))} />
            <Button appearance="subtle" icon={<ChevronRightRegular />} aria-label="Next" onClick={() => go(1)} />
          </>
        )}
        <Button appearance="subtle" icon={<DismissRegular />} onClick={onClose}>
          Exit
        </Button>
        {elapsed > 0 && <span className={s.progress} style={{ width: `${elapsed * 100}%` }} />}
      </div>
      <div className={s.body}>{slide.tenantId ? <Overview key={slide.tenantId} tenantId={slide.tenantId} can={can} /> : <AllCustomers onOpen={() => undefined} presenting />}</div>
    </div>
  );
}
