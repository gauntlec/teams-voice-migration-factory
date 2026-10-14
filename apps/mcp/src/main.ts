#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentApiClient } from './client';
import { createMcpServer } from './server';

/**
 * Voxshift incident tools over MCP (stdio). Configure your MCP client to run this with:
 *   VOXSHIFT_URL    https://www.directrouting.online   (the Voxshift address, no /api)
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
  const server = createMcpServer(new AgentApiClient({ baseUrl, token }));
  await server.connect(new StdioServerTransport());
  process.stderr.write('Voxshift MCP server ready.\n');
}

main().catch((e) => {
  process.stderr.write(`Voxshift MCP server failed: ${(e as Error).message}\n`);
  process.exit(1);
});
