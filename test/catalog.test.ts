import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { HaraGateway, InMemoryHostRegistry } from '../src/gateway.js';
import { createHaraMcpServer, TOOL_NAMES } from '../src/server.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(): Promise<Client> {
  const registry = new InMemoryHostRegistry();
  const server = createHaraMcpServer(new HaraGateway(registry));
  const client = new Client({ name: 'hara-mcp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await Promise.allSettled([client.close(), server.close(), registry.close()]);
  });
  return client;
}

describe('MCP tool catalogue', () => {
  it('publishes exactly four statically pure tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      });
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false
      });
      expect(tool.outputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false
      });
    }
  });
});
