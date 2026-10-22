import type { ReactNode } from 'react';
import { Link } from '@fluentui/react-components';
import { useNavigate } from 'react-router';

/**
 * The name in a list row (a sitecode, a reference) that opens the object's details. A real link, so it can also be opened
 * in a new tab with a middle-click or Ctrl/Cmd-click; a plain click moves within the app without reloading the page.
 */
export function RowLink({ to, children }: { to: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <Link
      href={to}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </Link>
  );
}
