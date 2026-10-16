import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  CheckedClient,
  UsageLimitError,
  NotSignedInError,
  describeError,
  errorJson,
  formatFinding,
  formatReport,
  formatSummary,
  formatUsage,
  formatPreview,
  issuesProvider,
  runOutcome,
  waitForRun,
  KIND_LABEL,
  VERSION as CORE_VERSION,
  type Capabilities,
} from '@checked/cli/core'

export const SERVER_VERSION = '0.1.0'

/** Longest a tool call may block waiting for a run (MCP clients time out long calls). */
export const MAX_WAIT_SECONDS = 600

export const INSTRUCTIONS = `Check’d runs API tests, website scans and AI exploratory tests against the user's own systems, and reports failures with evidence, a diagnosis and a fix.

How to use these tools:
- Read-only tools (whoami, list_*, get_*, wait_for_run) are free. Prefer them: look at the latest run before starting a new one.
- Tools that start work (start_run, start_scan, rerun_failed) use the workspace's usage allowance (a rolling session budget and a monthly allowance). Start one only when the user asks for a run or clearly needs fresh results, for example after changing code. Never loop on them.
- If a tool answers that the allowance is used up, stop and tell the user the message and when it resets. Do not retry.
- Projects and runs accept their ref (e.g. payments-kqzxm, hbtqwpmz) or numeric id. Finding ids look like r123 (a failed API test) or f456 (a website scan finding).
- To fix a failure: list_findings for the project, then get_finding for the full request, response, diagnosis and suggested fix; change the code; then start_run or rerun_failed to confirm.`

type Deps = { sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number }

const ref = (what: string) => z.union([z.string().min(1).max(120), z.number().int().positive()]).describe(`${what} ref (e.g. payments-kqzxm) or numeric id`)

function text(t: string, data?: unknown): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: t }]
  if (data !== undefined) content.push({ type: 'text', text: JSON.stringify(data) })
  return { content }
}

function fail(e: unknown): CallToolResult {
  let msg = describeError(e)
  if (e instanceof UsageLimitError && e.code !== 'plan') msg = `Usage limit reached: ${msg} Tell the user; do not retry until it resets.`
  if (e instanceof NotSignedInError) msg = 'Not signed in to Check’d. Set CHECKED_API_KEY in this MCP server’s environment (create a key in the app under Settings, API keys), or run `checked login` on this machine.'
  return { isError: true, content: [{ type: 'text', text: msg }, { type: 'text', text: JSON.stringify({ error: errorJson(e) }) }] }
}

function safe<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args)
    } catch (e) {
      return fail(e)
    }
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
/** Starts work on the server: costs usage, reaches out to the user's systems. */
const WORK = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const

const COSTS = 'Uses the workspace’s usage allowance (session and month).'

/**
 * Builds the MCP server around a Check’d client. Tools are grouped as read-only
 * (free) and work-starting (cost usage), and say so in their descriptions and
 * annotations so assistants call them correctly.
 */
export function createCheckedServer(client: CheckedClient, deps: Deps = {}): McpServer {
  const server = new McpServer({ name: 'checked', title: 'Check’d', version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  let capabilities: Capabilities | null = null
  const issues = async () => {
    if (!capabilities) capabilities = (await client.whoami().catch(() => null))?.capabilities ?? {}
    return issuesProvider(client, capabilities)
  }

  async function summaryText(runId: string | number, waitSeconds: number) {
    if (waitSeconds > 0) {
      const w = await waitForRun(client, runId, { timeoutMs: Math.min(waitSeconds, MAX_WAIT_SECONDS) * 1000, stream: false, pollMs: 5000, sleep: deps.sleep, now: deps.now })
      const s = await client.summary(runId)
      if (w.timedOut) return text(`${formatSummary(s)}\n\nStill ${s.run.status} after ${waitSeconds} s. Call wait_for_run or get_run later; do not start another run.`, s)
      const o = runOutcome(s)
      return text(`${formatSummary(s)}\n\n${o.reason}`, { ...s, outcome: o.reason, releaseGatesPassed: o.code === 0 })
    }
    const s = await client.summary(runId)
    return text(formatSummary(s), s)
  }

  /* ---------- read-only ---------- */

  server.registerTool(
    'whoami',
    { title: 'Who am I', description: 'Read-only. Shows which Check’d account or workspace API key this server uses, its workspaces and plans.', inputSchema: {}, annotations: READ },
    safe(async () => {
      const w = await client.whoami()
      capabilities = w.capabilities
      const who = w.kind === 'user' ? `Signed in as ${w.user?.email}` : `Using the workspace API key ${w.key?.name} (${w.key?.prefix}…)`
      return text(`${who}\nWorkspaces: ${w.workspaces.map((x) => `${x.slug} (${x.name}, ${x.plan}, ${x.role})`).join('; ') || 'none'}`, w)
    })
  )

  server.registerTool(
    'list_projects',
    { title: 'List projects', description: 'Read-only. Lists Check’d projects (API projects test endpoints; website projects are scanned in a browser) with their last run.', inputSchema: { workspace: z.string().max(80).optional().describe('Workspace slug or id; default all the credential can see') }, annotations: READ },
    safe(async ({ workspace }) => {
      const rows = await client.projects({ workspace })
      const lines = rows.map((p) => `- ${p.ref ?? p.id}: ${p.name} (${p.kind === 'frontend' ? 'website' : 'API'}${p.kind === 'backend' ? `, ${p.endpointCount} endpoints` : ''})${p.lastRun ? `, last run ${p.lastRun.ref} ${p.lastRun.status}` : ', no runs yet'}`)
      return text(rows.length ? lines.join('\n') : 'No projects yet.', rows)
    })
  )

  server.registerTool(
    'list_environments',
    { title: 'List environments', description: 'Read-only. Lists a project’s environments (base URL, auth type). Secrets are masked.', inputSchema: { project: ref('Project') }, annotations: READ },
    safe(async ({ project }) => {
      const rows = await client.environments(project)
      return text(rows.map((e) => `- ${e.id}: ${e.name} ${e.baseUrl} (auth ${String(e.auth?.type ?? 'none')})${e.isDefault ? ' [default]' : ''}`).join('\n') || 'No environments.', rows)
    })
  )

  server.registerTool(
    'list_runs',
    { title: 'List runs', description: 'Read-only. Recent runs of a project, newest first.', inputSchema: { project: ref('Project'), limit: z.number().int().min(1).max(50).optional(), status: z.string().max(60).optional().describe('Comma separated: queued, running, passed, failed, errored, cancelled') }, annotations: READ },
    safe(async ({ project, limit, status }) => {
      const rows = await client.runs(project, { limit: limit ?? 10, status })
      return text(rows.map((r) => `- ${r.ref ?? r.id}: ${KIND_LABEL[r.kind] ?? r.kind} ${r.status}${r.total ? ` (${r.passed}/${r.total} passed)` : ''}, ${r.createdAt}`).join('\n') || 'No runs yet.', rows)
    })
  )

  server.registerTool(
    'get_run',
    { title: 'Get run result', description: 'Read-only. A compact result for one run: status and counts, release gates, the AI verdict and the top problems with ids for get_finding.', inputSchema: { run: ref('Run') }, annotations: READ },
    safe(async ({ run }) => summaryText(run, 0))
  )

  server.registerTool(
    'wait_for_run',
    { title: 'Wait for a run', description: `Read-only. Waits (at most ${MAX_WAIT_SECONDS} s) for a queued or running run to finish, then returns its result. Does not start anything.`, inputSchema: { run: ref('Run'), timeout_seconds: z.number().int().min(5).max(MAX_WAIT_SECONDS).optional().describe('Default 300') }, annotations: READ },
    safe(async ({ run, timeout_seconds }) => summaryText(run, timeout_seconds ?? 300))
  )

  server.registerTool(
    'get_run_results',
    { title: 'Get test results', description: 'Read-only. Individual API test results of a run; filter to failures with status "failed,errored".', inputSchema: { run: ref('Run'), status: z.string().max(60).optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: READ },
    safe(async ({ run, status, limit }) => {
      const page = await client.results(run, { status, perPage: limit ?? 50 })
      return text(page.data.map((r) => `- r${r.id} ${r.status} ${r.endpoint ? `${r.endpoint.method} ${r.endpoint.path} ` : ''}${r.name}${r.status !== 'passed' && r.explanation?.headline ? `: ${r.explanation.headline}` : ''}`).join('\n') || 'No results.', page)
    })
  )

  server.registerTool(
    'get_run_report',
    { title: 'Get AI report', description: 'Read-only. The AI QA report for a run: verdict (ship, ship with care, hold), findings with impact and fixes, next steps, what was not tested.', inputSchema: { run: ref('Run') }, annotations: READ },
    safe(async ({ run }) => {
      const r = await client.report(run)
      return text(formatReport(r.report, r), r)
    })
  )

  const findingsInput = { project: ref('Project'), run: ref('Run').optional().describe('Default: the latest finished run'), severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional().describe('This severity and worse'), limit: z.number().int().min(1).max(200).optional() }
  const listFindings = (label: string) =>
    safe(async ({ project, run, severity, limit }: { project: string | number; run?: string | number; severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'; limit?: number }) => {
      const runId = run !== undefined ? (await client.run(run)).id : undefined
      const list = await (await issues()).list({ projectId: project, runId, severity, limit: limit ?? 30 })
      if (list.scope.kind === 'none') return text('No finished runs yet, so there is nothing to show.', list)
      const head = list.scope.kind === 'run' ? `From run ${list.scope.runRef ?? list.scope.runId} (${list.scope.status}); ${list.total} ${label}.` : ''
      return text([head, ...list.issues.map((f) => `- ${f.id} [${f.severity}] ${f.title}${f.endpoint ? ` (${f.endpoint.method} ${f.endpoint.path})` : f.url ? ` (${f.url})` : ''}`)].join('\n'), list)
    })
  const getFinding = safe(async ({ id }: { id: string }) => {
    const f = await (await issues()).show(id)
    return text(formatFinding(f, undefined, 6000), f)
  })

  server.registerTool('list_findings', { title: 'List findings', description: 'Read-only. Problems from a run (default the latest finished one): failed API tests and website scan findings, worst first.', inputSchema: findingsInput, annotations: READ }, listFindings('findings'))
  server.registerTool('get_finding', { title: 'Get finding', description: 'Read-only. One finding with its full evidence: the exact request and response, failed checks, stack trace or console errors when captured, the diagnosis and how to fix it.', inputSchema: { id: z.string().regex(/^[rRfF]?\d+$/).describe('r123 or f456') }, annotations: READ }, getFinding)
  server.registerTool('list_issues', { title: 'List issues', description: 'Read-only. Open issues for a project. Today these are the latest run’s findings (same as list_findings); production issues will appear here too once the issue inbox is available.', inputSchema: findingsInput, annotations: READ }, listFindings('issues'))
  server.registerTool('get_issue', { title: 'Get issue', description: 'Read-only. One issue with its evidence, diagnosis and fix (same ids as get_finding).', inputSchema: { id: z.string().regex(/^[rRfF]?\d+$/).describe('r123 or f456') }, annotations: READ }, getFinding)

  server.registerTool(
    'get_usage',
    { title: 'Get usage', description: 'Read-only. How much of this session’s and this month’s allowance the workspace has used, and whether new work is blocked.', inputSchema: { workspace: z.string().max(80).optional() }, annotations: READ },
    safe(async ({ workspace }) => {
      const u = await client.usage(workspace)
      return text(formatUsage(u), u)
    })
  )

  server.registerTool(
    'preview_import',
    { title: 'Preview an API import', description: 'Read-only (nothing is saved). Parses an OpenAPI, Swagger, Postman, Insomnia, HAR, GraphQL or cURL document, given as text or a URL, and says what an import into the project would add.', inputSchema: { project: ref('Project'), content: z.string().max(8_000_000).optional().describe('The document text'), url: z.string().url().optional().describe('Or a URL to fetch it from') }, annotations: { ...READ, openWorldHint: true } },
    safe(async ({ project, content, url }) => {
      const p = await client.importPreview(project, { content, url })
      return text(formatPreview(p, url ?? 'the document'), p)
    })
  )

  /* ---------- start work (uses allowance) ---------- */

  server.registerTool(
    'import_spec',
    { title: 'Import an API spec', description: 'Saves endpoints into an API project from an OpenAPI, Postman or other document (merged by method and path; replace swaps the whole list). Call preview_import first and confirm with the user. May start an AI reading of the API, which uses allowance.', inputSchema: { project: ref('Project'), content: z.string().max(8_000_000).optional(), url: z.string().url().optional(), replace: z.boolean().optional() }, annotations: { ...WORK, destructiveHint: true } },
    safe(async ({ project, content, url, replace }) => {
      const s = await client.importSave(project, { content, url, replace })
      return text(`Imported ${s.endpointCount} endpoints${s.title ? ` from ${s.title}` : ''}. ${s.projectUrl}`, s)
    })
  )

  server.registerTool(
    'start_run',
    {
      title: 'Start a test run',
      description: `Starts a run on a project: API tests for API projects, a website scan (or AI exploration) for website projects. ${COSTS} Optionally waits for the result (at most ${MAX_WAIT_SECONDS} s); otherwise use wait_for_run or get_run.`,
      inputSchema: {
        project: ref('Project'),
        environment: z.union([z.string(), z.number()]).optional().describe('Environment id or name; default is the project’s default'),
        kind: z.enum(['suite', 'frontend_health', 'frontend_explore', 'frontend_flow']).optional().describe('suite = API tests (default for API projects); frontend_health = website scan (default for website projects)'),
        depth: z.enum(['critical', 'standard', 'deep']).optional().describe('API runs: critical is fastest and cheapest; deep (default) runs every test'),
        suite_ids: z.array(z.number().int().positive()).max(100).optional(),
        start_url: z.string().url().optional().describe('Website runs: the page to start from'),
        max_pages: z.number().int().min(1).max(500).optional(),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe('Wait for the result up to this long (default 0: return at once)'),
      },
      annotations: WORK,
    },
    safe(async ({ project, environment, kind, depth, suite_ids, start_url, max_pages, wait_seconds }) => {
      let environmentId: number | undefined
      if (environment !== undefined) {
        const envs = await client.environments(project)
        const hit = typeof environment === 'number' || /^\d+$/.test(environment) ? envs.find((e) => e.id === Number(environment)) : envs.find((e) => e.name.toLowerCase() === String(environment).toLowerCase())
        if (!hit) return fail(new Error(`No environment "${environment}" on this project. It has: ${envs.map((e) => e.name).join(', ') || 'none'}.`))
        environmentId = hit.id
      }
      const run = await client.startRun(project, { kind, depth, suiteIds: suite_ids, environmentId, startUrl: start_url, maxPages: max_pages })
      if (!wait_seconds) return text(`Started ${KIND_LABEL[run.kind] ?? run.kind} ${run.ref ?? run.id} (${run.status}). Use wait_for_run with run "${run.ref ?? run.id}" for the result. ${run.url ?? ''}`, run)
      return summaryText(run.ref ?? run.id, wait_seconds)
    })
  )

  server.registerTool(
    'rerun_failed',
    { title: 'Re-run failed tests', description: `Re-runs only the failed and errored tests of a finished API run, in place, to confirm a fix. ${COSTS}`, inputSchema: { run: ref('Run') }, annotations: WORK },
    safe(async ({ run }) => {
      const r = await client.rerunFailed(run)
      return text(`Re-ran ${r.rerun} tests: ${r.fixed} now pass, ${r.stillFailing} still failing. The run is now ${r.run.status} (${r.run.passed}/${r.run.total} passed).`, r)
    })
  )

  server.registerTool(
    'start_scan',
    { title: 'Start a website scan', description: `Scans a website for broken links, console and network errors, accessibility and speed. Uses the workspace’s website project for that host, creating one if needed. ${COSTS}`, inputSchema: { url: z.string().url(), workspace: z.string().max(80).optional(), max_pages: z.number().int().min(1).max(500).optional(), wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional() }, annotations: WORK },
    safe(async ({ url, workspace, max_pages, wait_seconds }) => {
      const run = await client.scan({ url, workspace, maxPages: max_pages })
      if (!wait_seconds) return text(`Started a website scan ${run.ref ?? run.id} of ${url} in project ${run.project.name}. Use wait_for_run with run "${run.ref ?? run.id}". ${run.url ?? ''}`, run)
      return summaryText(run.ref ?? run.id, wait_seconds)
    })
  )

  server.registerTool(
    'cancel_run',
    { title: 'Cancel a run', description: 'Cancels a queued or running run. Stops further usage by that run.', inputSchema: { run: ref('Run') }, annotations: { ...WORK, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
    safe(async ({ run }) => {
      const r = await client.cancel(run)
      return text(`Run ${r.ref ?? r.id} is ${r.status}.`, r)
    })
  )

  /* ---------- resources ---------- */

  server.registerResource(
    'run-report',
    new ResourceTemplate('checked://runs/{run}/report', { list: undefined }),
    { title: 'Run AI report', description: 'The AI QA report of a run, as text.', mimeType: 'text/markdown' },
    async (uri, { run }) => {
      const r = await client.report(String(run))
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: formatReport(r.report, r) }] }
    }
  )
  server.registerResource(
    'run-summary',
    new ResourceTemplate('checked://runs/{run}/summary', { list: undefined }),
    { title: 'Run result', description: 'Status, release gates, verdict and top problems of a run.', mimeType: 'text/plain' },
    async (uri, { run }) => {
      const s = await client.summary(String(run))
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: formatSummary(s) }] }
    }
  )
  server.registerResource(
    'finding',
    new ResourceTemplate('checked://findings/{id}', { list: undefined }),
    { title: 'Finding', description: 'One finding with its evidence and fix.', mimeType: 'text/plain' },
    async (uri, { id }) => {
      const f = await client.finding(String(id))
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: formatFinding(f, undefined, 20000) }] }
    }
  )

  /* ---------- prompts ---------- */

  server.registerPrompt(
    'fix_failures',
    { title: 'Fix what Check’d found', description: 'Look at the latest run of a project, explain the failures and fix them in this codebase.', argsSchema: { project: z.string().describe('Project ref or id') } },
    ({ project }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Use the Check’d tools to look at the latest run of project ${project}: call get_run on its latest run (list_runs), then list_findings and get_finding for the worst ones. For each real product bug, find the cause in this codebase and fix it; for test or environment problems, say what to change in Check’d instead. Do not start new runs until the fixes are in; then use rerun_failed (API projects) to confirm.`,
          },
        },
      ],
    })
  )

  return server
}

export { CORE_VERSION }
