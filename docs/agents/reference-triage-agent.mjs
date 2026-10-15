// A small reference agent for the Voxshift incident API (docs/AGENTS.md). It shows the whole contract:
// read the queue, claim an incident, read its context, add an internal note, act or propose depending on
// the autonomy it has been given, hand over when it cannot help, and renew its lease while it works.
//
//   VOXSHIFT_URL=https://www.voxshift.io VOXSHIFT_TOKEN=vxs_agent_... node reference-triage-agent.mjs
//
// It does no thinking of its own: `diagnose()` is where your model or runbook goes. Everything else is
// plumbing you can lift as is. Nothing here changes an incident without the lease, and anything the
// autonomy policy doesn't allow directly becomes a proposal for a person to approve.

const REQUEST_TIMEOUT_MS = 20_000;

export function client({ baseUrl, token, fetchImpl = fetch }) {
  const root = `${baseUrl.replace(/\/+$/, '')}/api/agent/v1`;
  async function call(method, path, body, headers = {}) {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message ?? `${method} ${path} failed (${res.status})`);
      err.status = res.status;
      err.code = json.code; // taken_over, stale, propose_instead, in_flight ...
      err.body = json;
      throw err;
    }
    return json;
  }
  const at = (inc) => `/incidents/${inc.tenant_id}/${inc.id}`;
  return {
    me: () => call('GET', '/me'),
    queue: (qs = 'status=open&assigned=unassigned') => call('GET', `/incidents?${qs}`),
    events: (after) => call('GET', `/events?after=${after}&limit=100`),
    get: (inc) => call('GET', at(inc)),
    claim: (inc, note) => call('POST', `${at(inc)}/claim`, { ttlSeconds: 600, note }, { 'Idempotency-Key': `claim-${inc.id}-${Math.floor(Date.now() / 600_000)}` }),
    heartbeat: (inc) => call('POST', `${at(inc)}/claim/heartbeat`, { ttlSeconds: 600 }),
    release: (inc) => call('DELETE', `${at(inc)}/claim`),
    note: (inc, body, key, version) => call('POST', `${at(inc)}/notes`, { body, expectedVersion: version }, { 'Idempotency-Key': key }),
    status: (inc, to, note, key, version) => call('POST', `${at(inc)}/status`, { to, note, expectedVersion: version }, { 'Idempotency-Key': key }),
    propose: (inc, proposal, key) => call('POST', `${at(inc)}/proposals`, proposal, { 'Idempotency-Key': key }),
    handoff: (inc, summary, key) => call('POST', `${at(inc)}/handoff`, { to: 'queue', summary }, { 'Idempotency-Key': key }),
  };
}

/** Replace this with your model or runbook: look at the context and say what you think and what you would do. */
export function diagnose(context) {
  const i = context.incident;
  const known = context.knownErrors?.[0];
  const lines = [`Triage of ${i.reference}: ${i.category_label} at ${i.sitecode ?? 'all sites'}, priority ${i.priority}.`];
  if (known) lines.push(`Matches known error ${known.reference} (${known.title}). Workaround: ${known.workaround}`);
  if (context.similar?.length) lines.push(`${context.similar.length} similar open incident(s): ${context.similar.map((s) => s.reference).join(', ')}.`);
  return { note: lines.join('\n'), knownError: known ?? null, confident: !!known };
}

/** Works one unassigned incident from claim to hand-off. Returns what it did. */
export async function triage(api, inc) {
  const done = [];
  await api.claim(inc, 'Triage');
  done.push('claimed');
  try {
    const context = await api.get(inc);
    const version = context.incident.version;
    const verdict = diagnose(context);
    // An internal note is allowed from "suggest" up. The key makes a retry harmless; the version stops it landing on a stale view.
    await api.note(inc, verdict.note, `note-${inc.id}-v${version}`, version);
    done.push('noted');

    const autonomy = context.autonomy;
    if (context.incident.status === 'new') {
      if (autonomy.triage >= 3) {
        await api.status(inc, 'in_progress', undefined, `ack-${inc.id}`);
        done.push('acknowledged');
      } else if (autonomy.triage >= 1) {
        // Below "act alone" the answer is a proposal: a person approves it and the platform carries it out.
        await api.propose(inc, { kind: 'status_change', params: { to: 'in_progress' }, rationale: 'Triage is done and an engineer should pick this up.', risk: 'low' }, `propose-ack-${inc.id}`);
        done.push('proposed-acknowledge');
      }
    }
    await api.heartbeat(inc);
    if (!verdict.confident) {
      // Hand over with what we tried, found and recommend. The incident goes back to the queue (or a named person).
      await api.handoff(
        inc,
        { tried: ['Read the incident, known errors and similar incidents'], found: ['No known error matches'], recommendation: 'An engineer should look at this by hand.', confidence: 'low', evidence: [] },
        `handoff-${inc.id}`,
      );
      done.push('handed-off');
      return done;
    }
    await api.release(inc);
    done.push('released');
    return done;
  } catch (e) {
    // A person took the incident over, or it changed under us: stop, don't fight it.
    if (e.code === 'taken_over' || e.code === 'stale') {
      done.push(`stopped (${e.code})`);
      return done;
    }
    throw e;
  }
}

/**
 * One pass: triage every unassigned incident this agent may work. Letting go of an incident returns it to the queue, so
 * the agent remembers what it has handled (`handled`, kept between passes) instead of picking it up again.
 */
export async function runOnce(api, handled = new Set()) {
  const results = {};
  for (const inc of await api.queue()) {
    if (handled.has(inc.id)) continue;
    handled.add(inc.id);
    results[inc.reference] = await triage(api, inc).catch((e) => [`failed: ${e.message}`]);
  }
  return results;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const baseUrl = process.env.VOXSHIFT_URL;
  const token = process.env.VOXSHIFT_TOKEN;
  if (!baseUrl || !token) {
    console.error('Set VOXSHIFT_URL and VOXSHIFT_TOKEN.');
    process.exit(1);
  }
  const api = client({ baseUrl, token });
  // Ask who we are first: this assistant must be set up for incidents (Administration > Assistants > Works on).
  const me = await api.me();
  if (!me.worksOn.includes('incidents')) {
    console.error(`${me.name} is set up for ${me.worksOn.join(' and ')}, not incidents. Use an assistant set up for incidents.`);
    process.exit(1);
  }
  console.log(`${me.name} works on ${me.worksOn.join(', ')} for ${me.customers.length} customer(s).`);
  let after = 0;
  const handled = new Set();
  // Poll the queue, and the events feed for anything that needs a second look. A webhook could replace the polling.
  for (;;) {
    console.log(JSON.stringify(await runOnce(api, handled)));
    const feed = await api.events(after);
    for (const e of feed.events) console.log(`event ${e.id} ${e.kind} ${e.incident_id ?? ''}`);
    after = feed.next;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
