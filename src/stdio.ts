#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { HaraGateway, InMemoryHostRegistry } from './gateway.js';
import { createHaraMcpServer } from './server.js';
import { DeterministicTestHost } from './test-fixture-host.js';

const registry = new InMemoryHostRegistry();

if (process.env.HARA_MCP_ENABLE_TEST_FIXTURE === '1') {
  await registry.register(new DeterministicTestHost());
  console.error('[hara-mcp] deterministic transport fixture enabled; this is not Hara execution evidence');
}

const server = createHaraMcpServer(new HaraGateway(registry));
const transport = new StdioServerTransport();

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.allSettled([server.close(), registry.close()]);
}

process.once('SIGINT', () => {
  void close().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void close().finally(() => process.exit(0));
});

await server.connect(transport);
