import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CheckedClient, type FetchLike } from '@checked/cli/core'
import { createCheckedServer, INSTRUCTIONS } from '../src/server.js'

type Call = { method: string; path: string; query: URLSearchParams; body: any; auth?: string }

function api(route: (c: Call) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init = {}) => {
    const u = new URL(url)
    const h = (init.headers ?? {}) as Record<string, string>
    const c: Call = { method: init.method ?? 'GET', path: u.pathname.replace(/^\/api\/v1/, ''), query: u.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: h.Authorization }
    calls.push(c)
    const r = route(c) ?? { status: 404, body: { message: `no mock for ${c.method} ${c.path}` } }
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

async function connect(fetch: FetchLike, token: string | null = 'tfy_key') {
  const server = createCheckedServer(new CheckedClient({ apiUrl: 'http://api.test', token, fetch }), { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000) })() })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

const textOf = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n')

const runRow = (status: string) => ({ id: 7, ref: 'hbtqwpmz', kind: 'suite', status, total: 4, passed: 3, failed: 1, errored: 0, skipped: 0, durationMs: 9000, startedAt: null, finishedAt: null, createdAt: '2026-10-16T10:00:00Z', projectId: 3, url: 'http://app.test/r' })
const summaryOf = (status: string, gatesPassed = false) => ({ run: { ...runRow(status), done: status !== 'running' }, project: { id: 3, ref: 'pay-abcde', name: 'Payments API', kind: 'backend' }, url: 'http://app.test/r', gates: status === 'running' ? null : { passed: gatesPassed, pendingReport: false, checks: [{ key: 'pass_rate', label: 'Pass rate', ok: gatesPassed, actual: '75%', target: '≥ 95%' }] }, report: null, health: null, findingCount: 1, topFindings: [{ id: 'r12', severity: 'critical', title: 'POST /orders crashed with 500.', endpoint: { method: 'POST', path: '/orders' }, url: null, suggestion: 'Handle it' }] })

test('tools are listed with read-only and work-starting annotations and clear descriptions', async () => {
  const client = await connect(api(() => undefined).fetch)
  const { tools } = await client.listTools()
  const byName = new Map(tools.map((t) => [t.name, t]))
  const readOnly = ['whoami', 'list_projects', 'list_environments', 'list_runs', 'get_run', 'wait_for_run', 'get_run_results', 'get_run_report', 'list_findings', 'get_finding', 'list_issues', 'get_issue', 'get_usage', 'preview_import']
  const work = ['start_run', 'rerun_failed', 'start_scan', 'import_spec', 'cancel_run']
  assert.deepEqual([...byName.keys()].sort(), [...readOnly, ...work].sort())
  for (const n of readOnly) {
    assert.equal(byName.get(n)!.annotations?.readOnlyHint, true, n)
    assert.match(byName.get(n)!.description ?? '', /^Read-only/, n)
  }
  for (const n of work) assert.equal(byName.get(n)!.annotations?.readOnlyHint, false, n)
  for (const n of ['start_run', 'rerun_failed', 'start_scan']) assert.match(byName.get(n)!.description ?? '', /usage allowance/, n)
  // Schemas carry the inputs assistants must give.
  const start = byName.get('start_run')!.inputSchema as any
  assert.deepEqual(start.required, ['project'])
  assert.equal(start.properties.wait_seconds.maximum, 600)
  assert.deepEqual(start.properties.depth.enum, ['critical', 'standard', 'deep'])
  assert.deepEqual((byName.get('get_finding')!.inputSchema as any).required, ['id'])
  const info = client.getInstructions() ?? ''
  assert.equal(info, INSTRUCTIONS)
  assert.match(info, /Never loop on them/)
})

test('list_projects answers in text plus JSON, with the key as bearer', async () => {
  const { fetch, calls } = api((c) => (c.path === '/cli/projects' ? { body: { data: [{ id: 3, ref: 'pay-abcde', name: 'Payments API', kind: 'backend', endpointCount: 12, lastRun: runRow('failed') }] } } : undefined))
  const client = await connect(fetch)
  const r = await client.callTool({ name: 'list_projects', arguments: {} })
  assert.equal(r.isError, undefined)
  assert.match(textOf(r), /pay-abcde: Payments API \(API, 12 endpoints\), last run hbtqwpmz failed/)
  assert.equal(JSON.parse((r.content as any)[1].text)[0].ref, 'pay-abcde')
  assert.equal(calls[0].auth, 'Bearer tfy_key')
})

test('start_run with wait_seconds waits (bounded) and reports the gates', async () => {
  let polls = 0
  const { fetch, calls } = api((c) => {
    if (c.method === 'POST' && c.path === '/cli/projects/pay-abcde/runs') return { status: 201, body: { data: runRow('queued') } }
    if (c.path === '/cli/runs/hbtqwpmz') return { body: { data: runRow(++polls < 2 ? 'running' : 'failed') } }
    if (c.path === '/cli/runs/hbtqwpmz/summary') return { body: { data: summaryOf('failed') } }
    return undefined
  })
  const client = await connect(fetch)
  const r = await client.callTool({ name: 'start_run', arguments: { project: 'pay-abcde', depth: 'critical', wait_seconds: 60 } })
  assert.equal(r.isError, undefined, textOf(r))
  assert.deepEqual(calls[0].body, { depth: 'critical' })
  assert.match(textOf(r), /Release gates: not met/)
  assert.match(textOf(r), /Release gates not met: Pass rate 75%/)
  assert.match(textOf(r), /"releaseGatesPassed":false/)
})

test('start_run without waiting returns the run to wait on; a timeout says not to start another', async () => {
  const { fetch } = api((c) => {
    if (c.method === 'POST') return { status: 201, body: { data: runRow('queued') } }
    if (c.path === '/cli/runs/hbtqwpmz') return { body: { data: runRow('running') } }
    if (c.path === '/cli/runs/hbtqwpmz/summary') return { body: { data: summaryOf('running') } }
    return undefined
  })
  const client = await connect(fetch)
  const started = await client.callTool({ name: 'start_run', arguments: { project: 'pay-abcde' } })
  assert.match(textOf(started), /Use wait_for_run with run "hbtqwpmz"/)
  const waited = await client.callTool({ name: 'wait_for_run', arguments: { run: 'hbtqwpmz', timeout_seconds: 10 } })
  assert.match(textOf(waited), /Still running after 10 s.*do not start another run/s)
})

test('a 402 comes back as a tool error telling the assistant not to retry', async () => {
  const { fetch } = api((c) => (c.method === 'POST' ? { status: 402, body: { message: "You have used this session's allowance on Free. It refreshes in 2 hours.", code: 'session', resetAt: new Date(Date.now() + 7200_000).toISOString() } } : undefined))
  const client = await connect(fetch)
  const r = await client.callTool({ name: 'rerun_failed', arguments: { run: 'hbtqwpmz' } })
  assert.equal(r.isError, true)
  assert.match(textOf(r), /Usage limit reached: You have used this session's allowance on Free/)
  assert.match(textOf(r), /do not retry until it resets/)
  assert.match(textOf(r), /"exitCode":4/)
})

test('no credential: tools explain how to sign in instead of failing silently', async () => {
  const client = await connect(api(() => undefined).fetch, null)
  const r = await client.callTool({ name: 'list_projects', arguments: {} })
  assert.equal(r.isError, true)
  assert.match(textOf(r), /Set CHECKED_API_KEY/)
})

test('findings and issues: list then show with evidence', async () => {
  const finding = { id: 'r12', source: 'api_test', severity: 'critical', category: 'negative', title: 'POST /orders crashed with 500.', detail: 'The server failed while handling this request.', status: 'failed', runId: 7, runRef: 'hbtqwpmz', projectId: 3, endpoint: { method: 'POST', path: '/orders' }, url: 'https://api.example.com/orders', diagnosis: 'bug', suggestion: 'Handle the input', fix: ['Find the error in your logs', 'Handle the input'], steps: [], evidence: { request: { method: 'POST', url: 'https://api.example.com/orders', body: { qty: -1 } }, response: { status: 500, body: { error: 'Internal' } }, stack: 'TypeError: x is undefined\n    at createOrder (orders.ts:42)' }, createdAt: null, runUrl: 'http://app.test/r' }
  const { fetch, calls } = api((c) => {
    if (c.path === '/cli/whoami') return { body: { data: { kind: 'key', capabilities: { issuesInbox: false }, workspaces: [] } } }
    if (c.path === '/cli/projects/pay-abcde/findings') return { body: { data: [finding], meta: { run: { id: 7, ref: 'hbtqwpmz', kind: 'suite', status: 'failed', finishedAt: null, url: 'u' }, total: 1 } } }
    if (c.path === '/cli/findings/r12') return { body: { data: finding } }
    return undefined
  })
  const client = await connect(fetch)
  const l = await client.callTool({ name: 'list_issues', arguments: { project: 'pay-abcde', severity: 'high' } })
  assert.match(textOf(l), /From run hbtqwpmz \(failed\); 1 issues\./)
  assert.match(textOf(l), /- r12 \[critical\] POST \/orders crashed with 500\./)
  assert.equal(calls.find((c) => c.path.endsWith('/findings'))!.query.get('severity'), 'high')
  const s = await client.callTool({ name: 'get_finding', arguments: { id: 'r12' } })
  assert.match(textOf(s), /Stack trace\nTypeError: x is undefined/)
  assert.match(textOf(s), /"qty": -1/)
  const bad = await client.callTool({ name: 'get_finding', arguments: { id: 'nonsense' } })
  assert.equal(bad.isError, true)
})

test('resources: the run report reads as markdown text', async () => {
  const { fetch } = api((c) => (c.path === '/cli/runs/hbtqwpmz/report' ? { body: { data: { runId: 7, runRef: 'hbtqwpmz', status: 'failed', done: true, stale: false, url: 'http://app.test/r', report: { headline: 'Orders crash on bad input', healthScore: 61, summary: 'One crash.', verdict: 'hold', findings: [{ severity: 'critical', title: 'Crash on negative qty', detail: '500 on qty -1', suggestion: 'Validate qty' }], nextSteps: ['Validate input'] } } } } : undefined))
  const client = await connect(fetch)
  const { resourceTemplates } = await client.listResourceTemplates()
  assert.ok(resourceTemplates.some((t) => t.uriTemplate === 'checked://runs/{run}/report'))
  const r = await client.readResource({ uri: 'checked://runs/hbtqwpmz/report' })
  const t = (r.contents[0] as { text: string }).text
  assert.match(t, /Orders crash on bad input/)
  assert.match(t, /verdict hold/)
  assert.match(t, /Fix: Validate qty/)
  const { prompts } = await client.listPrompts()
  assert.deepEqual(prompts.map((p) => p.name), ['fix_failures'])
})

test('issues from the inbox: list with AI summaries, get with the explanation; findings stay on runs', async () => {
  const issue = { id: 'kqzxmvbt', ref: 'kqzxmvbt', source: 'production', kind: 'error', severity: 'critical', status: 'regressed', title: 'TypeError: total is undefined', culprit: null, errorType: 'TypeError', environment: 'production', occurrences: 46, usersAffected: 23, firstSeenAt: '2026-10-01T10:00:00Z', lastSeenAt: '2026-10-16T10:00:00Z', firstRelease: '1.4.0', lastRelease: '1.4.2', regressedInRelease: '1.4.2', explained: true, aiSummary: 'Checkout crashes after a promo code', hasFixPr: true, projectId: 3, url: 'http://app.test/projects/pay-abcde/issues/kqzxmvbt' }
  const explanation = { kind: 'ai', explanation: { summary: 'Checkout crashes after a promo code', whatIsBroken: 'Pay fails.', rootCause: 'total is read before the cart loads.', whoIsAffected: '23 users.', impact: 'critical', whereToLook: [{ file: 'src/cart/CartTotal.tsx', line: 42, function: 'formatTotal', why: 'No guard.' }], suggestedFix: ['Guard the total.'], confidence: 'high', confidenceReason: 'The frame shows it.', unknowns: [] }, basedOn: { occurrences: 46, usersAffected: 23, release: '1.4.2', at: '2026-10-16T08:00:00Z' }, source: null, model: 'm', generatedAt: '2026-10-16T08:00:00Z', stale: false, newOccurrences: 0, reasons: [] }
  const { fetch, calls } = api((c) => {
    if (c.path === '/cli/whoami') return { body: { data: { kind: 'key', capabilities: { issuesInbox: true }, workspaces: [] } } }
    if (c.path === '/cli/projects/pay-abcde/issues') return { body: { data: [issue], meta: { total: 1, url: 'http://app.test/projects/pay-abcde/issues' } } }
    if (c.path === '/cli/issues/kqzxmvbt') return { body: { data: { ...issue, evidence: { error: { type: 'TypeError', message: 'total is undefined', handled: false, mechanism: 'onerror' }, frames: [{ fn: 'formatTotal', file: '/src/cart/CartTotal.tsx', line: 42, column: 7 }], request: null, page: '/checkout/:id', breadcrumbs: [] }, explanation, fixPr: { id: 9, status: 'opened', url: 'https://github.com/acme/shop/pull/12', number: 12, branch: 'checked/fix-issue-kqzxmvbt-1017', mergedAt: null } } } }
    if (c.path === '/cli/projects/pay-abcde/findings') return { body: { data: [], meta: { run: { id: 7, ref: 'hbtqwpmz', kind: 'suite', status: 'passed', finishedAt: null, url: 'u' }, total: 0 } } }
    return undefined
  })
  const client = await connect(fetch)
  const l = await client.callTool({ name: 'list_issues', arguments: { project: 'pay-abcde', source: 'production', status: 'all' } })
  assert.match(textOf(l), /1 issues in the inbox, highest impact first/)
  assert.match(textOf(l), /- kqzxmvbt \[critical, regressed\] TypeError: total is undefined \(46 times, 23 users\)\. AI: Checkout crashes after a promo code\. Has a fix PR\./)
  const listCall = calls.find((c) => c.path.endsWith('/issues'))!
  assert.equal(listCall.query.get('source'), 'production')
  assert.equal(listCall.query.get('status'), 'all')
  const g = await client.callTool({ name: 'get_issue', arguments: { id: 'kqzxmvbt' } })
  assert.match(textOf(g), /Likely root cause\ntotal is read before the cart loads\./)
  assert.match(textOf(g), /- src\/cart\/CartTotal\.tsx:42 \(formatTotal\): No guard\./)
  assert.match(textOf(g), /Fix pull request: opened #12 https:\/\/github\.com\/acme\/shop\/pull\/12/)
  // list_findings still reads the latest run, whatever the server supports.
  const f = await client.callTool({ name: 'list_findings', arguments: { project: 'pay-abcde' } })
  assert.match(textOf(f), /From run hbtqwpmz \(passed\); 0 findings\./)
  // Nothing here writes or starts work.
  assert.ok(calls.every((c) => c.method === 'GET'))
})
