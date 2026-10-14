import type { ComponentProps } from 'react';
import { Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  danger: { color: tokens.colorPaletteRedForeground1 },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** Text that says something went wrong. Same colour everywhere, and it follows the theme (light, dark, white-label). */
export function DangerText({ className, ...rest }: ComponentProps<typeof Text>) {
  const s = useStyles();
  return <Text {...rest} className={mergeClasses(s.danger, className)} />;
}

/** Secondary text: hints, captions, "none yet". */
export function MutedText({ className, ...rest }: ComponentProps<typeof Text>) {
  const s = useStyles();
  return <Text {...rest} className={mergeClasses(s.muted, className)} />;
}
