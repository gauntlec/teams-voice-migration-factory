import type { ReactNode } from 'react';
import { Body1, Title2, makeStyles, shorthands, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  head: { ...shorthands.margin('0', '0', '20px') },
  sub: { color: tokens.colorNeutralForeground3, display: 'block', ...shorthands.margin('4px', '0', '0') },
  body: { display: 'grid', ...shorthands.gap('16px') },
});

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const s = useStyles();
  return (
    <div>
      <div className={s.head} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <Title2>{title}</Title2>
          {subtitle && <Body1 className={s.sub}>{subtitle}</Body1>}
        </div>
        {actions}
      </div>
      <div className={s.body}>{children}</div>
    </div>
  );
}
