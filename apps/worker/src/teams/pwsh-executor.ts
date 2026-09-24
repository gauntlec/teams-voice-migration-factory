import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { psQuote, renderCommand, renderPreambleStep, renderStatement } from '@tvmf/shared';
import type { CmdletInvocation, CmdletResult, DeviceCodePrompt, QueryOpts, TeamsExecutor } from './executor';

/**
 * Default per-command timeout. Big read cmdlets on a large tenant (a full
 * `Get-CsOnlineUser`) can legitimately run for many minutes, so this is
 * generous; `TEAMS_COMMAND_TIMEOUT_MS` overrides it.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.TEAMS_COMMAND_TIMEOUT_MS) || 15 * 60_000,
);

/**
 * Off by default - raw pwsh stdout/stderr is deliberately never persisted
 * (see the SECURITY note below: a device-code sign-in can echo auth details
 * to stderr). Set TEAMS_DEBUG_LOG_PATH to an explicit, temporary path to
 * `tail -f` exactly what's sent to and read from the session live while
 * debugging a hang - turn it back off afterwards, since the log can contain
 * whatever the tenant's own commands and responses contain.
 */
const DEBUG_LOG_PATH = process.env.TEAMS_DEBUG_LOG_PATH;
function debugLog(dir: 'OUT' | 'IN' | 'ERR', text: string) {
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${dir} ${text}\n`);
  } catch {
    /* best-effort only - never let debug logging break the executor */
  }
}

/**
 * Real executor: one long-lived `pwsh` child per connection running the
 * MicrosoftTeams module, signed in with a device code by the engineer.
 *
 * SECURITY (docs/SECURITY.md #1): the access/refresh tokens exist only inside
 * this child process. Nothing here reads them; stdout is consumed only to (a)
 * pick out the device-code line and (b) parse the JSON we explicitly asked for
 * between sentinel markers. Raw stdout/stderr is never logged.
 */
export class PwshTeamsExecutor implements TeamsExecutor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private errBuf = '';
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Map<string, { out: string[]; resolve: (v: string) => void; reject: (e: Error) => void }> =
    new Map();
  private devicePrompt: { resolve: (p: DeviceCodePrompt) => void; reject: (e: Error) => void } | null = null;
  private signIn: Promise<{ upn: string; tenantId: string }> | null = null;
  private signedIn = false;
  private disposed = false;
  lastUsedAt = Date.now();

  private graphPrompt: { resolve: (p: DeviceCodePrompt) => void; reject: (e: Error) => void } | null = null;
  private graphSignIn: Promise<{ upn: string }> | null = null;
  private graphSignedIn = false;

  constructor(private readonly opts: { signInTimeoutMs?: number; commandTimeoutMs?: number } = {}) {}

  /**
   * True while the pwsh child is up and signed in. A slow or failing cmdlet does
   * not clear this - only the child exiting, `dispose()`, or a failed start do
   * (see `fail()` / `dispose()`).
   */
  get alive(): boolean {
    return this.signedIn && !!this.child && !this.disposed;
  }

  get graphAlive(): boolean {
    return this.graphSignedIn && !!this.child && !this.disposed;
  }

  /* ------------------------------ process ------------------------------ */

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    // NB: not `-Command -` / `-File -` - those read stdin until EOF before
    // running anything. With plain redirected stdin pwsh executes line by line,
    // which is what a long-lived session needs.
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1', TERM: 'dumb', NO_COLOR: '1' },
    });
    // quiet the session: no prompt echo, no progress bars, keep going on errors
    child.stdin.write(
      "function prompt { ' ' }; $ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Continue'; $PSStyle.OutputRendering = 'PlainText'\n",
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      debugLog('IN', chunk);
      this.onStdout(chunk);
    });
    // stderr is never logged or surfaced (it could echo auth details). The only
    // thing we look for on it is the device-code prompt, in case the module
    // writes that line to the error/warning stream on this host.
    child.stderr.on('data', (chunk: string) => {
      debugLog('ERR', chunk);
      this.errBuf += chunk;
      let nl: number;
      while ((nl = this.errBuf.indexOf('\n')) >= 0) {
        const line = this.errBuf.slice(0, nl).replace(/\r$/, '');
        this.errBuf = this.errBuf.slice(nl + 1);
        this.matchDevicePrompt(line);
      }
      if (this.errBuf) this.matchDevicePrompt(this.errBuf);
      if (this.errBuf.length > 64_000) this.errBuf = this.errBuf.slice(-8_000);
    });
    const fail = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.devicePrompt?.reject(err);
      this.devicePrompt = null;
      this.graphPrompt?.reject(err);
      this.graphPrompt = null;
      this.signedIn = false;
      this.graphSignedIn = false;
      this.child = null;
    };
    child.on('error', (e) => fail(new Error(`could not start pwsh: ${e.message}`)));
    child.on('exit', (code) => fail(new Error(`pwsh exited (${code ?? 'signal'})`)));
    this.child = child;
    return child;
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.onLine(line);
    }
    // The module prints the device-code message WITHOUT a trailing newline
    // (the cursor parks there until sign-in completes), so also look at the
    // partial line still sitting in the buffer.
    if (this.buf) this.matchDevicePrompt(this.buf);
  }

  /**
   * The device-code prompt while Connect-MicrosoftTeams (or Connect-MgGraph)
   * is blocking. Only one sign-in is ever in flight at a time - Graph always
   * runs after Teams is already connected - so this is one shared slot: the
   * Graph prompt takes priority when both are somehow set.
   */
  private matchDevicePrompt(line: string): boolean {
    const graph = !!this.graphPrompt;
    const slot = this.graphPrompt ?? this.devicePrompt;
    if (!slot) return false;
    const m = /open the page (\S+) and enter the code ([A-Z0-9-]{6,})/i.exec(line);
    if (!m) return false;
    if (graph) this.graphPrompt = null;
    else this.devicePrompt = null;
    slot.resolve({
      userCode: m[2],
      verificationUri: m[1].replace(/[.,]$/, ''),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    return true;
  }

  private onLine(line: string) {
    if (this.matchDevicePrompt(line)) return;
    const end = /^__END__([0-9a-f-]{36})$/.exec(line);
    if (end) {
      const p = this.pending.get(end[1]);
      if (p) {
        this.pending.delete(end[1]);
        p.resolve(p.out.join('\n'));
      }
      return;
    }
    // attach output lines to whichever command is running (there is at most one)
    const cur = this.pending.values().next().value as { out: string[] } | undefined;
    if (cur) cur.out.push(line);
  }

  /**
   * Run a script and return everything it printed up to the sentinel. Commands
   * are serialised - the module is not safe to drive concurrently.
   */
  private exec(
    script: string,
    timeoutMs = this.opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (this.disposed) return reject(new Error('executor disposed'));
        const child = this.ensureChild();
        const id = randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`pwsh command timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        this.pending.set(id, {
          out: [],
          resolve: (v) => {
            clearTimeout(timer);
            this.lastUsedAt = Date.now();
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        // One physical line per command: the script goes over base64 so
        // multi-line try/catch blocks and quoting never confuse the line reader.
        const b64 = Buffer.from(script, 'utf16le').toString('base64');
        debugLog('OUT', `[${id}] ${script}`);
        child.stdin.write(
          `iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}'))); Write-Output '__END__${id}'\n`,
        );
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /* ----------------------------- TeamsExecutor ----------------------------- */

  async beginDeviceCode(tenantDomain: string | null): Promise<DeviceCodePrompt> {
    this.ensureChild();
    // tenantDomain is already validated as `[a-z0-9.-]+` at the API boundary
    // (packages/shared/src/dto.ts startConnectionSchema), but escape properly
    // rather than strip - see psQuote in packages/shared/src/deployment.ts.
    const tenantArg = tenantDomain ? ` -TenantId ${psQuote(tenantDomain)}` : '';
    const prompt = new Promise<DeviceCodePrompt>((resolve, reject) => {
      this.devicePrompt = { resolve, reject };
    });
    // The connect call blocks until the engineer completes sign-in (or ~15 min).
    // Its result object carries Account/TenantId; we print only those two.
    this.signIn = this.exec(
      `Import-Module MicrosoftTeams -ErrorAction Stop
try {
  $c = Connect-MicrosoftTeams -UseDeviceAuthentication${tenantArg} -ErrorAction Stop
  $acct = if ($c.Account -is [string]) { $c.Account } else { $c.Account.Id }
  Write-Output ('__SIGNIN__' + (@{ upn = $acct; tenantId = [string]$c.TenantId } | ConvertTo-Json -Compress))
} catch { Write-Output ('__SIGNINERR__' + $_.Exception.Message) }`,
      this.opts.signInTimeoutMs ?? 16 * 60_000,
    ).then((out) => {
      const ok = out.split('\n').find((l) => l.startsWith('__SIGNIN__'));
      if (!ok) {
        const err = out.split('\n').find((l) => l.startsWith('__SIGNINERR__'));
        throw new Error(err ? err.slice('__SIGNINERR__'.length) : 'sign-in did not complete');
      }
      const j = JSON.parse(ok.slice('__SIGNIN__'.length)) as { upn: string | null; tenantId: string };
      this.signedIn = true;
      return { upn: j.upn ?? 'unknown', tenantId: j.tenantId };
    });
    // surface sign-in failures to beginDeviceCode's caller if the code never came
    this.signIn.catch((e) => this.devicePrompt?.reject(e));
    return prompt;
  }

  awaitSignIn(): Promise<{ upn: string; tenantId: string }> {
    if (!this.signIn) return Promise.reject(new Error('beginDeviceCode() not called'));
    return this.signIn;
  }

  /* ------------------------- Microsoft Graph (groups) ------------------------- */

  /**
   * Second device-code sign-in, for Microsoft Graph, so Design & Build can
   * search M365 groups by name for the Shared Voicemail `groupId` field.
   * Uses the Microsoft Graph PowerShell first-party app and the delegated,
   * read-only `Group.Read.All` scope; the token stays inside this process
   * exactly like the Teams one. Requires `Connect-MicrosoftTeams` to have
   * completed already (one shared prompt slot, see `matchDevicePrompt`).
   */
  async beginGraphDeviceCode(): Promise<DeviceCodePrompt> {
    if (!this.signedIn) throw new Error('not connected');
    this.ensureChild();
    const prompt = new Promise<DeviceCodePrompt>((resolve, reject) => {
      this.graphPrompt = { resolve, reject };
    });
    this.graphSignIn = this.exec(
      `Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
try {
  Connect-MgGraph -UseDeviceAuthentication -NoWelcome -Scopes 'Group.Read.All' -ErrorAction Stop
  $acct = (Get-MgContext).Account
  Write-Output ('__GSIGNIN__' + (@{ upn = [string]$acct } | ConvertTo-Json -Compress))
} catch { Write-Output ('__GSIGNINERR__' + $_.Exception.Message) }`,
      this.opts.signInTimeoutMs ?? 16 * 60_000,
    ).then((out) => {
      const ok = out.split('\n').find((l) => l.startsWith('__GSIGNIN__'));
      if (!ok) {
        const err = out.split('\n').find((l) => l.startsWith('__GSIGNINERR__'));
        throw new Error(err ? err.slice('__GSIGNINERR__'.length) : 'Graph sign-in did not complete');
      }
      const j = JSON.parse(ok.slice('__GSIGNIN__'.length)) as { upn: string | null };
      this.graphSignedIn = true;
      return { upn: j.upn ?? 'unknown' };
    });
    this.graphSignIn.catch((e) => this.graphPrompt?.reject(e as Error));
    return prompt;
  }

  awaitGraphSignIn(): Promise<{ upn: string }> {
    if (!this.graphSignIn) return Promise.reject(new Error('beginGraphDeviceCode() not called'));
    return this.graphSignIn;
  }

  /** GET a Graph collection, following `@odata.nextLink`. Returns the merged `value` arrays. */
  async graphList(path: string): Promise<unknown[]> {
    if (!this.graphSignedIn) throw new Error('Graph not connected');
    const clean = `/${String(path).replace(/^\/+/, '')}`;
    const out = await this.exec(
      `try {
  $all = @(); $u = 'https://graph.microsoft.com/v1.0${clean}'
  while ($u) {
    $resp = Invoke-MgGraphRequest -Method GET -Uri $u -OutputType PSObject -ErrorAction Stop
    if ($resp.value) { $all += $resp.value } else { $all += $resp }
    $u = $resp.'@odata.nextLink'
  }
  Write-Output ('__JSON__' + (ConvertTo-Json -InputObject $all -Depth 6 -Compress))
} catch { Write-Output ('__ERR__' + $_.Exception.Message) }`,
    );
    for (const line of out.split('\n')) {
      if (line.startsWith('__JSON__')) {
        const parsed = JSON.parse(line.slice('__JSON__'.length)) as unknown;
        return parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed];
      }
      if (line.startsWith('__ERR__')) throw new Error(line.slice('__ERR__'.length));
    }
    return [];
  }

  /**
   * Run a read cmdlet and return its records as JSON. `params` are rendered as
   * `-Name value`. `opts.select` narrows the object (big pulls stay small),
   * `opts.depth` bounds nesting, `opts.timeoutMs` extends the leash.
   */
  async query(
    command: string,
    params: Record<string, unknown> = {},
    opts: QueryOpts = {},
  ): Promise<unknown[]> {
    if (!this.signedIn) throw new Error('not connected');
    const rendered = renderCommand({ cmdlet: command, parameters: params, objectType: '' });
    const depth = opts.depth ?? 6;
    // Select-Object drops the ~80 properties we never read, so a 15k-user
    // response serialises in a fraction of the time and size.
    const project = opts.select?.length
      ? ` | Select-Object ${opts.select.map((f) => f.replace(/[^A-Za-z0-9_]/g, '')).join(',')}`
      : '';
    const out = await this.exec(
      `try {
  $r = @(${rendered} -ErrorAction Stop${project})
  Write-Output ('__JSON__' + (ConvertTo-Json -InputObject $r -Depth ${depth} -Compress))
} catch { Write-Output ('__ERR__' + $_.Exception.Message) }`,
      opts.timeoutMs,
    );
    for (const line of out.split('\n')) {
      if (line.startsWith('__JSON__')) {
        const parsed = JSON.parse(line.slice('__JSON__'.length)) as unknown;
        return parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed];
      }
      if (line.startsWith('__ERR__')) throw new Error(line.slice('__ERR__'.length));
    }
    return [];
  }

  /** Runs one already-fully-rendered statement and returns its error message, or null on success. */
  private async execStatement(statement: string): Promise<string | null> {
    const out = await this.exec(`try { ${statement}; Write-Output '__OK__' } catch { Write-Output ('__ERR__' + $_.Exception.Message) }`);
    const err = out.split('\n').find((l) => l.startsWith('__ERR__'));
    return err ? err.slice('__ERR__'.length) : null;
  }

  /**
   * Every preamble step, then the final call, is its own separate exec()
   * round-trip - not one bundled multi-line script. pwsh session state
   * (`$ce1`, `$sched1`, ...) persists across these since they run on the same
   * long-lived child process, serialised through `exec`'s queue. This means a
   * hang or error pins to one named step (its own timeout, its own message)
   * instead of being lost inside an opaque combined script - confirmed live
   * in production: a stuck Auto Attendant build gave no way to tell which of
   * its several local constructions vs. the final New-CsAutoAttendant call
   * was the one actually stuck.
   */
  async invoke(call: CmdletInvocation, opts: { whatIf: boolean }): Promise<CmdletResult> {
    if (!this.signedIn) return { result: 'failed', before: {}, after: {}, message: 'not connected' };
    const rendered = renderCommand(call);
    if (opts.whatIf) return { result: 'whatif', before: {}, after: {}, message: rendered };
    // A step can fail two different ways: PowerShell itself catches an
    // exception (execStatement's own __ERR__ sentinel), or exec()'s timeout
    // rejects the whole promise from outside PowerShell entirely (nothing
    // ever printed __END__). Both need to land on the SAME labelled message -
    // missing the second case was exactly why the first version of this still
    // reported a bare "pwsh command timed out after 900s" with no step name,
    // confirmed live in production on a run this fix was supposed to pin down.
    const runStep = async (statement: string, label: string): Promise<CmdletResult | null> => {
      try {
        const err = await this.execStatement(statement);
        return err ? { result: 'failed', before: {}, after: {}, message: `${label}: ${err}` } : null;
      } catch (e) {
        return { result: 'failed', before: {}, after: {}, message: `${label}: ${(e as Error).message}` };
      }
    };
    for (const step of call.preamble ?? []) {
      const base = renderPreambleStep(step);
      // A call step's return value must land in its variable untouched, so
      // it's never piped to Out-Null (that would replace the real result
      // with Out-Null's own empty output) - -ErrorAction Stop as a plain
      // parameter is still safe, since it's evaluated before the assignment.
      // An assign step is a bare property set, not a cmdlet call, so no
      // -ErrorAction parameter applies to it at all.
      const statement = step.kind === 'assign' ? base : `${base} -ErrorAction Stop`;
      const label = step.kind === 'assign' ? `$${step.target}.${step.property}` : `$${step.assignTo} = ${step.cmdlet}`;
      const failure = await runStep(statement, label);
      if (failure) return failure;
    }
    const failure = await runStep(`${renderStatement(call.cmdlet, call.parameters)} -ErrorAction Stop | Out-Null`, call.cmdlet);
    if (failure) return failure;
    return { result: 'applied', before: {}, after: call.parameters, message: rendered };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.signedIn = false;
    this.graphSignedIn = false;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.write('Disconnect-MicrosoftTeams -ErrorAction SilentlyContinue\nDisconnect-MgGraph -ErrorAction SilentlyContinue\nexit\n');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000).unref();
    }
    for (const p of this.pending.values()) p.reject(new Error('executor disposed'));
    this.pending.clear();
  }
}
