import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  renderCommand,
  type CmdletInvocation,
  type CmdletResult,
  type DeviceCodePrompt,
  type TeamsExecutor,
} from './executor';

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
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Map<string, { out: string[]; resolve: (v: string) => void; reject: (e: Error) => void }> =
    new Map();
  private devicePrompt: { resolve: (p: DeviceCodePrompt) => void; reject: (e: Error) => void } | null = null;
  private signIn: Promise<{ upn: string; tenantId: string }> | null = null;
  private signedIn = false;
  private disposed = false;
  lastUsedAt = Date.now();

  constructor(private readonly opts: { signInTimeoutMs?: number; commandTimeoutMs?: number } = {}) {}

  /* ------------------------------ process ------------------------------ */

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1', TERM: 'dumb' },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    // stderr is deliberately not surfaced (could echo auth details); errors are
    // captured per command via try/catch inside the script we send.
    child.stderr.on('data', () => undefined);
    child.on('exit', (code) => {
      const err = new Error(`pwsh exited (${code ?? 'signal'})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.devicePrompt?.reject(err);
      this.signedIn = false;
      this.child = null;
    });
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
  }

  private onLine(line: string) {
    // device code prompt while Connect-MicrosoftTeams is blocking
    if (this.devicePrompt) {
      const m = /open the page (\S+) and enter the code ([A-Z0-9-]+)/i.exec(line);
      if (m) {
        const p = this.devicePrompt;
        this.devicePrompt = null;
        p.resolve({
          userCode: m[2],
          verificationUri: m[1].replace(/[.,]$/, ''),
          expiresAt: new Date(Date.now() + 15 * 60_000),
        });
        return;
      }
    }
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
  private exec(script: string, timeoutMs = this.opts.commandTimeoutMs ?? 10 * 60_000): Promise<string> {
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
        child.stdin.write(`${script}\nWrite-Output '__END__${id}'\n`);
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /* ----------------------------- TeamsExecutor ----------------------------- */

  async beginDeviceCode(tenantDomain: string | null): Promise<DeviceCodePrompt> {
    this.ensureChild();
    const tenantArg = tenantDomain ? ` -TenantId '${tenantDomain.replace(/'/g, '')}'` : '';
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

  /**
   * Run a read cmdlet and return its records as JSON. `params` are rendered as
   * `-Name value`. Depth is bounded so huge nested objects stay parseable.
   */
  async query(command: string, params: Record<string, unknown> = {}, depth = 6): Promise<unknown[]> {
    if (!this.signedIn) throw new Error('not connected');
    const rendered = renderCommand({ cmdlet: command, parameters: params, objectType: '' });
    const out = await this.exec(
      `try {
  $r = @(${rendered} -ErrorAction Stop)
  Write-Output ('__JSON__' + (ConvertTo-Json -InputObject $r -Depth ${depth} -Compress))
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

  async invoke(call: CmdletInvocation, opts: { whatIf: boolean }): Promise<CmdletResult> {
    if (!this.signedIn) return { result: 'failed', before: {}, after: {}, message: 'not connected' };
    const rendered = renderCommand(call);
    if (opts.whatIf) return { result: 'whatif', before: {}, after: {}, message: rendered };
    const out = await this.exec(
      `try { ${rendered} -ErrorAction Stop | Out-Null; Write-Output '__OK__' } catch { Write-Output ('__ERR__' + $_.Exception.Message) }`,
    );
    const err = out.split('\n').find((l) => l.startsWith('__ERR__'));
    if (err) return { result: 'failed', before: {}, after: {}, message: err.slice('__ERR__'.length) };
    return { result: 'applied', before: {}, after: call.parameters, message: rendered };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.signedIn = false;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.write('Disconnect-MicrosoftTeams -ErrorAction SilentlyContinue\nexit\n');
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
