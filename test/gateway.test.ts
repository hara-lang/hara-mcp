import { describe, expect, it } from 'vitest';

import { HaraGateway, InMemoryHostRegistry, type ExecutionHostProtocol } from '../src/gateway.js';
import {
  EXECUTION_HOST_PROTOCOL,
  PURE_PROFILE,
  type ExecutionRequest,
  type ExecutionResult,
  type HostDescriptor
} from '../src/protocol.js';
import { DeterministicTestHost } from '../src/test-fixture-host.js';

const FIXED_REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function incompatibleHost(): ExecutionHostProtocol {
  const descriptor: HostDescriptor = {
    protocol: EXECUTION_HOST_PROTOCOL,
    hostId: 'fixture.incompatible',
    generation: 1,
    kind: 'test-fixture',
    state: 'ready',
    backend: 'fixture',
    runtimeBuild: `sha256:${'0'.repeat(64)}`,
    haraVersion: 'fixture-only',
    profiles: ['another.profile/0-alpha'],
    operations: ['runtime.get'],
    limits: {
      maxSourceBytes: 65_536,
      maxOutputBytes: 1_048_576,
      maxWallMs: 30_000
    },
    observedAt: '2026-08-21T00:00:00.000Z'
  };

  return {
    describe: async () => descriptor,
    execute: async (_request: ExecutionRequest): Promise<ExecutionResult> => {
      throw new Error('incompatible host must not execute');
    },
    cancel: async () => false,
    close: async () => {}
  };
}

describe('HaraGateway', () => {
  it('fails explicitly when no host is registered', async () => {
    const gateway = new HaraGateway(new InMemoryHostRegistry());

    await expect(gateway.runtimeGet()).rejects.toMatchObject({
      code: 'host_unavailable'
    });
  });

  it('rejects a ready host without the pure profile', async () => {
    const registry = new InMemoryHostRegistry();
    await registry.register(incompatibleHost());
    const gateway = new HaraGateway(registry);

    await expect(gateway.runtimeGet()).rejects.toMatchObject({
      code: 'host_incompatible'
    });
  });

  it('routes an exact eval request through the deterministic transport fixture', async () => {
    const registry = new InMemoryHostRegistry();
    await registry.register(new DeterministicTestHost({ now: () => new Date('2026-08-21T00:00:00.000Z') }));
    const gateway = new HaraGateway(registry, { idFactory: () => FIXED_REQUEST_ID });

    const result = await gateway.eval({ source: '(+ 40 2)' });

    expect(result.status).toBe('completed');
    expect(result.value).toEqual({ text: '42', json: 42 });
    expect(result.runtime.hostId).toBe('fixture.local');
    expect(result.evidence.profile).toBe(PURE_PROFILE);
    await registry.close();
  });

  it('propagates an aborted request signal to the selected host', async () => {
    const registry = new InMemoryHostRegistry();
    await registry.register(new DeterministicTestHost({ now: () => new Date('2026-08-21T00:00:00.000Z') }));
    const gateway = new HaraGateway(registry, { idFactory: () => FIXED_REQUEST_ID });
    const controller = new AbortController();
    controller.abort();

    const result = await gateway.eval({ source: '(+ 40 2)' }, controller.signal);

    expect(result.status).toBe('cancelled');
    expect(result.diagnostics).toEqual([
      {
        code: 'fixture/cancelled',
        severity: 'error',
        message: 'The deterministic fixture request was cancelled.'
      }
    ]);
    await registry.close();
  });

  it('invokes the fixture qualified-call boundary without source construction', async () => {
    const registry = new InMemoryHostRegistry();
    await registry.register(new DeterministicTestHost({ now: () => new Date('2026-08-21T00:00:00.000Z') }));
    const gateway = new HaraGateway(registry, { idFactory: () => FIXED_REQUEST_ID });

    const result = await gateway.call({
      namespace: 'example.core',
      symbol: 'add',
      arguments: [40, 2]
    });

    expect(result.status).toBe('completed');
    expect(result.value?.json).toBe(42);
    await registry.close();
  });

  it('does not silently clamp a request above the server limit', async () => {
    const registry = new InMemoryHostRegistry();
    await registry.register(new DeterministicTestHost());
    const gateway = new HaraGateway(registry);

    await expect(
      gateway.eval({
        source: '(+ 40 2)',
        limits: { wallMs: 30_001 }
      })
    ).rejects.toThrow();
    await registry.close();
  });
});
