import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { HaraGateway, InMemoryHostRegistry } from '../src/gateway.js';
import { createHaraMcpServer } from '../src/server.js';
import { DeterministicTestHost } from '../src/test-fixture-host.js';

interface ConnectedHarness {
  client: Client;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connect(withFixture: boolean): Promise<ConnectedHarness> {
  const registry = new InMemoryHostRegistry();
  if (withFixture) {
    await registry.register(new DeterministicTestHost({ now: () => new Date('2026-08-21T00:00:00.000Z') }));
  }
  const server = createHaraMcpServer(new HaraGateway(registry));
  const client = new Client({ name: 'hara-mcp-integration-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const close = async (): Promise<void> => {
    await Promise.allSettled([client.close(), server.close(), registry.close()]);
  };
  cleanups.push(close);
  return { client, close };
}

describe('MCP integration', () => {
  it('routes a valid tool call through the deterministic transport fixture', async () => {
    const { client } = await connect(true);
    const response = await client.callTool({
      name: 'hara_eval',
      arguments: { source: '(+ 40 2)' }
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      result: {
        status: 'completed',
        value: { text: '42', json: 42 },
        runtime: { hostId: 'fixture.local', backend: 'deterministic-fixture' }
      }
    });
  });

  it('returns a stable structured error when no compatible host exists', async () => {
    const { client } = await connect(false);
    const response = await client.callTool({
      name: 'hara_eval',
      arguments: { source: '(+ 40 2)' }
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: 'host_unavailable',
        message: 'no Hara execution host is registered'
      }
    });
  });

  it('rejects unknown input fields through the closed MCP schema', async () => {
    const { client } = await connect(true);
    const response = await client.callTool({
      name: 'hara_eval',
      arguments: {
        source: '(+ 40 2)',
        browser: true
      }
    });

    expect(response.isError).toBe(true);
    const firstBlock = response.content[0];
    expect(firstBlock).toMatchObject({ type: 'text' });
    expect(firstBlock?.type === 'text' ? firstBlock.text : '').toContain('Invalid arguments');
  });
});
