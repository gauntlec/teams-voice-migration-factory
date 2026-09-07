import { Card, CardHeader, Text, Badge, makeStyles, shorthands } from '@fluentui/react-components';
import { useAuth } from '../auth';
import { Page } from '../components/Page';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', ...shorthands.gap('16px') },
  card: { ...shorthands.padding('16px') },
});

const STEPS = [
  { key: 'data-collection', title: '1 · Data Collection', desc: 'Customer completes the discovery of sites, numbers and call flows.' },
  { key: 'build', title: '2 · Design & Build', desc: 'Engineers map users and phones to Teams voice policies.' },
  { key: 'deployment', title: '3 · Deployment', desc: 'Apply changes to the customer tenant with a full change audit.' },
  { key: 'handover', title: '4 · Service Handover', desc: 'Generate the handover pack documenting the final configuration.' },
];

export function Dashboard() {
  const s = useStyles();
  const { me, activeTenantId } = useAuth();
  const activeTenant = me?.tenants.find((t) => t.id === activeTenantId);

  return (
    <Page
      title={`Welcome, ${me?.displayName ?? ''}`}
      subtitle={
        activeTenant
          ? `Active customer: ${activeTenant.name}`
          : me?.role === 'SUPER_ADMIN'
            ? 'Create a customer under Administration → Customers to begin.'
            : 'You have not been assigned to a customer yet.'
      }
    >
      <Text>
        Role: <Badge appearance="tint">{me?.role}</Badge>
      </Text>
      <div className={s.grid}>
        {STEPS.map((step) => (
          <Card key={step.key} className={s.card}>
            <CardHeader header={<Text weight="semibold">{step.title}</Text>} />
            <Text size={200}>{step.desc}</Text>
          </Card>
        ))}
      </div>
    </Page>
  );
}
