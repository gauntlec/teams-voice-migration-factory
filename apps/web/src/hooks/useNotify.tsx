import { Toast, ToastBody, ToastTitle, useToastController } from '@fluentui/react-components';

/** The one toaster for the signed-in app (rendered by AppShell). A toast is polite live-region text, so screen readers hear it too. */
export const TOASTER_ID = 'app-toaster';

type Intent = 'success' | 'error' | 'warning' | 'info';

/** `notify('Invitation sent')` for a completed action; add `{ intent: 'error' }` for a failure the person should know about. */
export function useNotify() {
  const { dispatchToast } = useToastController(TOASTER_ID);
  return (title: string, opts?: { body?: string; intent?: Intent }) =>
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
        {opts?.body && <ToastBody>{opts.body}</ToastBody>}
      </Toast>,
      { intent: opts?.intent ?? 'success', timeout: opts?.intent === 'error' ? 8000 : 4000 },
    );
}
