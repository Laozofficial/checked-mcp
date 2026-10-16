# @checked/mcp

An MCP server (stdio) that lets AI assistants use Check’d: read run results, AI reports and findings with their evidence, and, when you ask, start runs, re-run failed tests or scan a website.

Needs Node.js 20 or newer. Built on the official MCP TypeScript SDK and the `@checked/cli` core.

## Credentials

- `CHECKED_API_KEY`: a workspace API key (Settings, API keys in the app). Reaches that workspace only.
- or `CHECKED_TOKEN`, or the sign-in saved by `checked login` on this machine.
- `CHECKED_API_URL`: only if you use a server other than `https://getchecked.twelveai.app`.

Without a credential the server still starts; every tool answers with how to sign in.

## Add it

Claude Code:

```sh
claude mcp add checked --env CHECKED_API_KEY=tfy_your_key -- npx -y @checked/mcp
```

Cursor (`.cursor/mcp.json`, or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "checked": { "command": "npx", "args": ["-y", "@checked/mcp"], "env": { "CHECKED_API_KEY": "tfy_your_key" } }
  }
}
```

VS Code (`.vscode/mcp.json`; VS Code asks for the key once):

```json
{
  "inputs": [{ "type": "promptString", "id": "checked-api-key", "description": "Check’d workspace API key", "password": true }],
  "servers": {
    "checked": { "type": "stdio", "command": "npx", "args": ["-y", "@checked/mcp"], "env": { "CHECKED_API_KEY": "${input:checked-api-key}" } }
  }
}
```

## Tools

Read-only (free; `readOnlyHint: true`):

| Tool | What it does |
| --- | --- |
| `whoami` | Which account or key, workspaces, plans |
| `list_projects` | Projects with their last run |
| `list_environments` | A project’s environments (secrets masked) |
| `list_runs` | Recent runs |
| `get_run` | Status, release gates, AI verdict, top problems with finding ids |
| `wait_for_run` | Waits up to 600 s for a run to finish |
| `get_run_results` | Individual API test results |
| `get_run_report` | The AI QA report |
| `list_findings`, `get_finding` | Failed tests and scan findings; full request, response, checks, stack trace, diagnosis and fix |
| `list_issues`, `get_issue` | Issues; today the same data as findings (see the seam below) |
| `get_usage` | Session and month usage, and whether work is blocked |
| `preview_import` | What an API import would add; nothing saved |

Start work or change things (`readOnlyHint: false`; descriptions say they use allowance):

| Tool | What it does |
| --- | --- |
| `start_run` | Start a run; optional `wait_seconds` (max 600) returns the result |
| `rerun_failed` | Re-run only the failed tests of a finished API run |
| `start_scan` | Website scan (uses or creates the workspace’s project for that host) |
| `import_spec` | Save endpoints from an API document |
| `cancel_run` | Cancel a run |

Each tool returns a readable text answer plus the JSON it was built from. Errors come back as `isError` results; a 402 says the allowance is used up, when it resets, and not to retry.

Resources: `checked://runs/{run}/report`, `checked://runs/{run}/summary`, `checked://findings/{id}`. Prompt: `fix_failures` (look at the latest run of a project and fix what it found).

The server sends instructions to the client: prefer read-only tools, start work only when asked, never loop on work-starting tools, and stop on a usage limit.

## Issues seam

The issue tools use `issuesProvider()` from `@checked/cli/core`. It reads findings today; when `/cli/whoami` reports `capabilities.issuesInbox: true`, that function returns an inbox-backed provider and these tools switch over unchanged.

## Development

```sh
npm install     # links ../cli; build it first (cd ../cli && npm run build)
npm test        # tool schemas and handlers against a mocked API, over an in-memory MCP transport
npm run build
CHECKED_API_KEY=tfy_... CHECKED_API_URL=http://localhost:4300 node dist/bin.js
```
