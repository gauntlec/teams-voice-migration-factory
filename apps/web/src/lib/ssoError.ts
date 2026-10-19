import { SSO_PUBLIC_ERRORS, isSsoPublicError } from '@tvmf/shared';

/** Why single sign-on did not work, if the page was reached from a refused sign-in (`/?sso_error=<code>`). The code is looked up in a fixed list; nothing from the address is shown as it is. */
export function readSsoError(): string | null {
  try {
    const code = new URLSearchParams(window.location.search).get('sso_error');
    return code === null ? null : SSO_PUBLIC_ERRORS[isSsoPublicError(code) ? code : 'failed'];
  } catch {
    return null;
  }
}

/** Takes the code out of the address once it has been read, so a reload or a bookmark does not show the message again. */
export function forgetSsoError(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('sso_error')) return;
    params.delete('sso_error');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  } catch {
    /* the message simply stays in the address */
  }
}
