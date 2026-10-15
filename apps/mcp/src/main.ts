#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentApiClient } from './client';
import { AGENT_DOMAINS, type AgentDomain } from '@tvmf/shared';
import { createMcpServer } from './server';

/**
 * Voxshift incident tools over MCP (stdio). Configure your MCP client to run this with:
 *   VOXSHIFT_URL    https://www.voxshift.io   (the Voxshift address, no /api)
 *   VOXSHIFT_TOKEN  vxs_agent_...                       (Administration -> Assistants -> Tokens)
 * Nothing is written to stdout except the protocol; messages go to stderr.
 */
async function main() {
  const baseUrl = process.env.VOXSHIFT_URL;
  const token = process.env.VOXSHIFT_TOKEN;
  if (!baseUrl || !token) {
    process.stderr.write('Set VOXSHIFT_URL and VOXSHIFT_TOKEN. See docs/MCP.md.\n');
    process.exit(1);
  }
  const client = new AgentApiClient({ baseUrl, token });
  // Ask Voxshift where this assistant works, and offer only those tools. If it cannot be asked (the network, an older Voxshift), offer all of
  // them: the API still refuses anything the assistant is not set up for.
  let worksOn: readonly AgentDomain[] = AGENT_DOMAINS;
  try {
    worksOn = (await client.me()).worksOn;
    process.stderr.write(`Voxshift assistant works on: ${worksOn.join(', ')}.\n`);
  } catch (e) {
    process.stderr.write(`Could not read this assistant's areas (${(e as Error).message}); offering every tool.\n`);
  }
  const server = createMcpServer(client, {}, worksOn);
  await server.connect(new StdioServerTransport());
  process.stderr.write('Voxshift MCP server ready.\n');
}

main().catch((e) => {
  process.stderr.write(`Voxshift MCP server failed: ${(e as Error).message}\n`);
  process.exit(1);
});
