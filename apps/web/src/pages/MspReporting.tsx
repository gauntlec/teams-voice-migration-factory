import { Suspense, lazy, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Spinner } from '@fluentui/react-components';
import { PresenterRegular } from '@fluentui/react-icons';
import { useAuth } from '../auth';
import { Page } from '../components/Page';

// Loaded on their own: they bring the chart library.
const AllCustomers = lazy(() => import('./overview/AllCustomers').then((m) => ({ default: m.AllCustomers })));
const Presenter = lazy(() => import('./overview/Presenter').then((m) => ({ default: m.Presenter })));

/**
 * MSP › Customer reporting (docs/INSIGHTS.md, step 5): every customer the person can open, worst first, the Portfolio
 * report, and Present mode cycling through every customer. Home keeps only the active customer's Overview and My work.
 */
export function MspReporting() {
  const { me, can, setActiveTenant } = useAuth();
  const navigate = useNavigate();
  const [presenting, setPresenting] = useState(false);
  // All customers first, then each customer's Overview in turn.
  const slides = [{ key: 'all', title: 'All customers', tenantId: null }, ...(me?.tenants ?? []).map((t) => ({ key: t.id, title: t.name, tenantId: t.id }))];
  return (
    <Page
      title="Customer reporting"
      subtitle="Every customer you work with, worst first, from each customer’s own Overview figures. Select a customer to open its Overview."
      actions={
        <Button icon={<PresenterRegular />} onClick={() => setPresenting(true)}>
          Present
        </Button>
      }
    >
      {presenting && (
        <Suspense fallback={null}>
          <Presenter slides={slides} can={can} onClose={() => setPresenting(false)} />
        </Suspense>
      )}
      <Suspense fallback={<Spinner label="Loading every customer…" />}>
        <AllCustomers
          onOpen={(id) => {
            setActiveTenant(id);
            try {
              localStorage.setItem('voxshift.home.tab', 'overview');
            } catch {
              // private window: Home opens on its default tab anyway
            }
            navigate('/');
          }}
        />
      </Suspense>
    </Page>
  );
}
