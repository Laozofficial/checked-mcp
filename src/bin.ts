#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CheckedClient, readConfig, resolveApiUrl, resolveCredential } from 'checkd-cli/core'
import { createCheckedServer, SERVER_VERSION } from './server.js'

/**
 * stdio MCP server. Credentials: CHECKED_API_KEY (a workspace API key), or
 * CHECKED_TOKEN, or the sign-in saved by `checked login`. CHECKED_API_URL picks
 * the server (default production). Logs go to stderr; stdout is the protocol.
 */
async function start() {
  const config = await readConfig()
  const apiUrl = resolveApiUrl({ env: process.env, config })
  const credential = resolveCredential(process.env, config)
  if (!credential) process.stderr.write('checked-mcp: no credential found. Set CHECKED_API_KEY, or run `checked login`. Tools will explain this when called.\n')
  const client = new CheckedClient({ apiUrl, token: credential?.token ?? null, userAgent: `checked-mcp/${SERVER_VERSION}` })
  const server = createCheckedServer(client)
  await server.connect(new StdioServerTransport())
  process.stderr.write(`checked-mcp ${SERVER_VERSION} ready (${apiUrl}, ${credential ? credential.source : 'not signed in'})\n`)
}

start().catch((e) => {
  process.stderr.write(`checked-mcp failed to start: ${(e as Error)?.stack ?? e}\n`)
  process.exit(1)
})
