#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { HaraGateway, InMemoryHostRegistry } from './gateway.js';
import { LoopbackRelayCoordinator, LoopbackRelayServer } from './loopback-relay.js';
import { LOOPBACK_RELAY_DEFAULT_PORT } from './relay-protocol.js';
import { createHaraMcpServer } from './server.js';
import { DeterministicTestHost } from './test-fixture-host.js';

function parsePort(value: string | undefined): number {
  if (value === undefined) return LOOPBACK_RELAY_DEFAULT_PORT;
  if (!/^\d+$/u.test(value)) throw new Error('HARA_MCP_LOOPBACK_PORT must be a decimal TCP port');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('HARA_MCP_LOOPBACK_PORT must be between 1 and 65535');
  }
  return port;
}

const fixtureEnabled = process.env.HARA_MCP_ENABLE_TEST_FIXTURE === '1';
const pairingToken = process.env.HARA_MCP_LOOPBACK_TOKEN;
const relayConfigured =
  pairingToken !== undefined ||
  process.env.HARA_MCP_LOOPBACK_PORT !== undefined ||
  process.env.HARA_MCP_LOOPBACK_ORIGIN !== undefined;

if (fixtureEnabled && relayConfigured) {
  throw new Error('the deterministic fixture and loopback relay cannot be enabled in the same process');
}
if (relayConfigured && pairingToken === undefined) {
  throw new Error('HARA_MCP_LOOPBACK_TOKEN is required when loopback relay settings are present');
}

const registry = new InMemoryHostRegistry();
let relay: LoopbackRelayServer | null = null;

if (fixtureEnabled) {
  await registry.register(new DeterministicTestHost());
  console.error('[hara-mcp] deterministic transport fixture enabled; this is not Hara execution evidence');
}

if (pairingToken !== undefined) {
  const coordinator = new LoopbackRelayCoordinator({
    onFirstHost: async (host) => {
      await registry.register(host);
    }
  });
  relay = new LoopbackRelayServer(coordinator, {
    pairingToken,
    port: parsePort(process.env.HARA_MCP_LOOPBACK_PORT),
    ...(process.env.HARA_MCP_LOOPBACK_ORIGIN === undefined
      ? {}
      : { allowedOrigin: process.env.HARA_MCP_LOOPBACK_ORIGIN })
  });
  const address = await relay.start();
  console.error(`[hara-mcp] loopback execution-host relay listening at ${address.url}`);
}

const server = createHaraMcpServer(new HaraGateway(registry));
const transport = new StdioServerTransport();

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.allSettled([server.close(), relay?.close(), registry.close()]);
}

process.once('SIGINT', () => {
  void close().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void close().finally(() => process.exit(0));
});
process.stdin.once('end', () => {
  void close();
});
process.stdin.once('close', () => {
  void close();
});

await server.connect(transport);
