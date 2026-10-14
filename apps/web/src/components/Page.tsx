import { useEffect, type ReactNode } from 'react';
import { Badge, Body1, Title2, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useAuth } from '../auth';

const useStyles = makeStyles({
  root: { minWidth: 0 },
  narrow: { maxWidth: '1200px' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', ...shorthands.gap('8px', '16px'), ...shorthands.margin('0', '0', '20px') },
  titles: { minWidth: 0, flex: '1 1 280px' },
  title: { display: 'block', letterSpacing: '-0.01em', lineHeight: tokens.lineHeightHero700, ...shorthands.margin('0') },
  customer: { display: 'flex', alignItems: 'center', ...shorthands.gap('6px'), ...shorthands.margin('0', '0', '2px'), color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  sub: { color: tokens.colorNeutralForeground3, display: 'block', ...shorthands.margin('4px', '0', '0') },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', ...shorthands.gap('8px') },
  body: { display: 'grid', ...shorthands.gap('16px') },
});

/**
 * The standard page: a real `h1`, the document title (so the browser tab and history say where you are), the customer you are acting
 * on (the costliest mistake in an MSP tool is acting on the wrong one), a one-line purpose and the page's actions.
 *
 * - `platform`: the page is not about one customer (administration, the MSP consoles, feedback), so no customer line.
 * - `narrow`: a form or detail page; cap the reading width instead of stretching to the window. Grids leave it off.
 */
export function Page({
  title,
  subtitle,
  actions,
  platform,
  narrow,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  platform?: boolean;
  narrow?: boolean;
  children: ReactNode;
}) {
  const s = useStyles();
  const { me, activeTenantId } = useAuth();
  const tenant = platform ? undefined : me?.tenants.find((t) => t.id === activeTenantId);

  useEffect(() => {
    const parts = [title, tenant?.name, 'Voxshift'].filter(Boolean);
    document.title = parts.join(' · ');
  }, [title, tenant?.name]);

  return (
    <div className={narrow ? `${s.root} ${s.narrow}` : s.root}>
      <div className={s.head}>
        <div className={s.titles}>
          {tenant && (
            <div className={s.customer}>
              <span>{tenant.name}</span>
              {tenant.sandbox && (
                <Badge appearance="tint" color="warning" size="small">
                  Test customer
                </Badge>
              )}
            </div>
          )}
          <Title2 as="h1" className={s.title}>
            {title}
          </Title2>
          {subtitle && <Body1 className={s.sub}>{subtitle}</Body1>}
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
      <div className={s.body}>{children}</div>
    </div>
  );
}
