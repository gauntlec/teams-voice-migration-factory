/**
 * Abstraction over "run a MicrosoftTeams cmdlet against the connected customer
 * tenant". Two implementations:
 *
 *  - SimulatedTeamsExecutor  (this scaffold) - records what WOULD run.
 *  - PwshTeamsExecutor        (to build)     - real `pwsh` child process with
 *      the MicrosoftTeams module, authenticated by a live device-code sign-in.
 *
 * SECURITY: an executor holds the customer access token ONLY in memory for the
 * life of the connection. It is never returned, logged, or persisted.
 * See docs/SECURITY.md.
 */

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
}

export interface CmdletInvocation {
  cmdlet: string;
  parameters: Record<string, unknown>;
  objectType: string;
  objectId?: string;
}

export interface CmdletResult {
  result: 'applied' | 'skipped' | 'failed' | 'whatif';
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  message?: string;
}

export interface TeamsExecutor {
  /** Begin device-code sign-in; resolves once the code is available to show. */
  beginDeviceCode(tenantDomain: string | null): Promise<DeviceCodePrompt>;
  /** Resolves when the engineer has completed sign-in (or rejects on timeout). */
  awaitSignIn(): Promise<{ upn: string; tenantId: string }>;
  /** Run one cmdlet. `whatIf` => generate the command text, do not change anything. */
  invoke(call: CmdletInvocation, opts: { whatIf: boolean }): Promise<CmdletResult>;
  /** Tear down the pwsh session and wipe the token from memory. */
  dispose(): Promise<void>;
}

export class SimulatedTeamsExecutor implements TeamsExecutor {
  private signedIn = false;

  async beginDeviceCode(_tenantDomain: string | null = null): Promise<DeviceCodePrompt> {
    return {
      userCode: 'SIMULATED-CODE',
      verificationUri: 'https://microsoft.com/devicelogin',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
  }

  async awaitSignIn(): Promise<{ upn: string; tenantId: string }> {
    await new Promise((r) => setTimeout(r, 3000));
    this.signedIn = true;
    return { upn: 'engineer@customer.example', tenantId: '00000000-0000-0000-0000-000000000000' };
  }

  async invoke(call: CmdletInvocation, opts: { whatIf: boolean }): Promise<CmdletResult> {
    if (!this.signedIn) return { result: 'failed', before: {}, after: {}, message: 'not connected' };
    const rendered = renderCommand(call);
    if (opts.whatIf) {
      return { result: 'whatif', before: {}, after: {}, message: rendered };
    }
    return {
      result: 'applied',
      before: { simulated: true },
      after: { simulated: true, ...call.parameters },
      message: `simulated: ${rendered}`,
    };
  }

  async dispose(): Promise<void> {
    this.signedIn = false;
  }
}

/** Render a cmdlet + params as the PowerShell one-liner (used for What-If output). */
export function renderCommand(call: CmdletInvocation): string {
  const parts = [call.cmdlet];
  for (const [k, v] of Object.entries(call.parameters)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean') parts.push(`-${k} $${v}`);
    else parts.push(`-${k} ${JSON.stringify(String(v))}`);
  }
  return parts.join(' ');
}

/*
 * TODO PwshTeamsExecutor:
 *  - spawn `pwsh -NoLogo -NoProfile -Command -` and keep stdin open
 *  - `Import-Module MicrosoftTeams`
 *  - `Connect-MicrosoftTeams -UseDeviceAuthentication` and scrape the code line
 *  - marshal invoke() calls as `<cmdlet> @{...} | ConvertTo-Json`
 *  - on dispose: `Disconnect-MicrosoftTeams`, kill the process, null the token
 */
