import { createHash } from 'node:crypto';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { HaraGateway, InMemoryHostRegistry } from '../src/gateway.js';
import { LoopbackRelayCoordinator, LoopbackRelayServer, RelayError } from '../src/loopback-relay.js';
import { createHaraMcpServer } from '../src/server.js';
import {
  LOOPBACK_RELAY_PROTOCOL,
  RelayAcceptedResponseSchema,
  RelayCommandSchema,
  RelayErrorResponseSchema,
  RelayHealthResponseSchema,
  RelayRegisterResponseSchema
} from '../src/relay-protocol.js';
import {
  EXECUTION_HOST_PROTOCOL,
  EXECUTION_RESULT_PROTOCOL,
  PURE_PROFILE,
  type ExecutionRequest,
  type ExecutionResult,
  type HostDescriptor
} from '../src/protocol.js';

const TOKEN = 'phase-1-loopback-development-token';
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const FIRST_REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_REQUEST_ID = '00000000-0000-4000-8000-000000000002';

interface HttpJsonResponse {
  status: number;
  body: unknown;
}

interface RelayHarness {
  baseUrl: string;
  coordinator: LoopbackRelayCoordinator;
  registry: InMemoryHostRegistry;
  server: LoopbackRelayServer;
}

class ManualClock {
  #milliseconds = Date.parse('2026-08-21T00:00:00.000Z');

  readonly now = (): Date => new Date(this.#milliseconds);

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function descriptor(generation = 1, overrides: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    protocol: EXECUTION_HOST_PROTOCOL,
    hostId: 'hara-chrome.local',
    generation,
    kind: 'browser-wasm',
    state: 'ready',
    backend: 'rust-wasm-test-transport',
    runtimeBuild: digest('restricted browser wasm fixture'),
    haraVersion: '0.1.0-test',
    profiles: [PURE_PROFILE],
    operations: ['runtime.get', 'sandbox.eval', 'sandbox.call', 'sandbox.check'],
    limits: {
      maxSourceBytes: 65_536,
      maxOutputBytes: 1_048_576,
      maxWallMs: 30_000
    },
    observedAt: '2026-08-21T00:00:00.000Z',
    ...overrides
  };
}

function terminalResult(
  request: ExecutionRequest,
  host: HostDescriptor,
  options: {
    status?: ExecutionResult['status'];
    text?: string;
    json?: number;
    sourceDigest?: string;
  } = {}
): ExecutionResult {
  const status = options.status ?? 'completed';
  const text = options.text ?? '42';
  const json = options.json ?? 42;
  return {
    protocol: EXECUTION_RESULT_PROTOCOL,
    requestId: request.requestId,
    runId: `relay:${request.requestId}`,
    status,
    value: status === 'completed' ? { text, json } : null,
    stdout: '',
    stderr: '',
    diagnostics:
      status === 'completed'
        ? []
        : [
            {
              code: `relay-test/${status}`,
              severity: 'error',
              message: `Transport fixture ended with ${status}.`
            }
          ],
    runtime: {
      hostId: host.hostId,
      hostGeneration: host.generation,
      backend: host.backend,
      runtimeBuild: host.runtimeBuild,
      haraVersion: host.haraVersion
    },
    evidence: {
      profile: PURE_PROFILE,
      sourceDigest: options.sourceDigest ?? request.sourceDigest,
      startedAt: '2026-08-21T00:00:00.000Z',
      completedAt: '2026-08-21T00:00:00.001Z',
      elapsedMs: 1,
      cleanup: 'completed'
    }
  };
}

async function startHarness(
  options: {
    allowedOrigin?: string;
    clock?: ManualClock;
    hostTtlMs?: number;
    cleanupGraceMs?: number;
    maxBodyBytes?: number;
  } = {}
): Promise<RelayHarness> {
  const registry = new InMemoryHostRegistry();
  const coordinator = new LoopbackRelayCoordinator({
    ...(options.clock === undefined ? {} : { now: options.clock.now }),
    ...(options.hostTtlMs === undefined ? {} : { hostTtlMs: options.hostTtlMs }),
    ...(options.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: options.cleanupGraceMs }),
    onFirstHost: async (host) => {
      await registry.register(host);
    }
  });
  const server = new LoopbackRelayServer(coordinator, {
    pairingToken: TOKEN,
    port: 0,
    ...(options.allowedOrigin === undefined ? {} : { allowedOrigin: options.allowedOrigin }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes })
  });
  const address = await server.start();
  const close = async (): Promise<void> => {
    await Promise.allSettled([server.close(), registry.close()]);
  };
  cleanups.push(close);
  return { baseUrl: address.url, coordinator, registry, server };
}

async function connectMcpClient(registry: InMemoryHostRegistry): Promise<Client> {
  const server = createHaraMcpServer(new HaraGateway(registry));
  const client = new Client({ name: 'hara-mcp-loopback-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  return client;
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  options: { token?: string | null; origin?: string } = {}
): Promise<HttpJsonResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.origin !== undefined) headers.origin = options.origin;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function registerHost(
  harness: RelayHarness,
  host: HostDescriptor = descriptor(),
  options: { origin?: string } = {}
): Promise<void> {
  const response = await post(
    harness.baseUrl,
    '/v0/host/register',
    { protocol: LOOPBACK_RELAY_PROTOCOL, descriptor: host },
    options
  );
  expect(response.status).toBe(201);
  expect(RelayRegisterResponseSchema.parse(response.body)).toMatchObject({
    accepted: true,
    hostId: host.hostId,
    generation: host.generation
  });
}

function identity(host: HostDescriptor): object {
  return {
    protocol: LOOPBACK_RELAY_PROTOCOL,
    hostId: host.hostId,
    generation: host.generation
  };
}

describe('loopback relay security boundary', () => {
  it('refuses non-loopback bind addresses and wildcard origins', () => {
    const coordinator = new LoopbackRelayCoordinator();

    expect(
      () =>
        new LoopbackRelayServer(coordinator, {
          pairingToken: TOKEN,
          bindAddress: '0.0.0.0'
        })
    ).toThrow(RelayError);
    expect(
      () =>
        new LoopbackRelayServer(coordinator, {
          pairingToken: TOKEN,
          allowedOrigin: 'chrome-extension://*'
        })
    ).toThrow(RelayError);
  });

  it('requires the development token, exact configured origin, and closed registration schema', async () => {
    const harness = await startHarness({ allowedOrigin: ORIGIN });
    const host = descriptor();

    const unauthenticated = await post(
      harness.baseUrl,
      '/v0/host/register',
      { protocol: LOOPBACK_RELAY_PROTOCOL, descriptor: host },
      { token: null, origin: ORIGIN }
    );
    expect(unauthenticated.status).toBe(401);
    expect(RelayErrorResponseSchema.parse(unauthenticated.body).error.code).toBe('authentication_failed');

    const wrongOrigin = await post(
      harness.baseUrl,
      '/v0/host/register',
      { protocol: LOOPBACK_RELAY_PROTOCOL, descriptor: host },
      { origin: 'https://example.invalid' }
    );
    expect(wrongOrigin.status).toBe(403);
    expect(RelayErrorResponseSchema.parse(wrongOrigin.body).error.code).toBe('origin_forbidden');

    const widened = await post(
      harness.baseUrl,
      '/v0/host/register',
      { protocol: LOOPBACK_RELAY_PROTOCOL, descriptor: host, browserAuthority: true },
      { origin: ORIGIN }
    );
    expect(widened.status).toBe(400);
    expect(RelayErrorResponseSchema.parse(widened.body).error.code).toBe('invalid_request');

    await registerHost(harness, host, { origin: ORIGIN });
    expect(JSON.stringify(harness.coordinator.health())).not.toContain(TOKEN);
  });

  it('rejects bodies above the configured relay bound without retaining them', async () => {
    const harness = await startHarness({ maxBodyBytes: 1_024 });
    const response = await fetch(`${harness.baseUrl}/v0/host/register`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ padding: 'x'.repeat(2_048) })
    });

    expect(response.status).toBe(413);
    expect(RelayErrorResponseSchema.parse((await response.json()) as unknown).error.code).toBe('body_too_large');
  });

  it('rejects incompatible manifests and locks the relay to one host identity', async () => {
    const harness = await startHarness();
    const incompatible = await post(harness.baseUrl, '/v0/host/register', {
      protocol: LOOPBACK_RELAY_PROTOCOL,
      descriptor: descriptor(1, { profiles: ['hara.trusted-root/0-alpha'] })
    });
    expect(incompatible.status).toBe(400);
    expect(RelayErrorResponseSchema.parse(incompatible.body).error.code).toBe('host_incompatible');

    const host = descriptor();
    await registerHost(harness, host);
    const collision = await post(harness.baseUrl, '/v0/host/register', {
      protocol: LOOPBACK_RELAY_PROTOCOL,
      descriptor: descriptor(2, { hostId: 'another-hara-host.local' })
    });
    expect(collision.status).toBe(409);
    expect(RelayErrorResponseSchema.parse(collision.body).error.code).toBe('host_collision');
  });
});

describe('loopback host lifecycle', () => {
  it('routes one request through real HTTP polling and makes terminal results immutable', async () => {
    const harness = await startHarness();
    const host = descriptor();
    await registerHost(harness, host);

    const ids = [FIRST_REQUEST_ID, SECOND_REQUEST_ID];
    const gateway = new HaraGateway(harness.registry, {
      idFactory: () => ids.shift() ?? SECOND_REQUEST_ID
    });
    const pending = gateway.eval({ source: '(+ 40 2)' });

    await expect(gateway.eval({ source: '(+ 1 1)' })).rejects.toMatchObject({ code: 'host_busy' });

    const poll = await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 });
    expect(poll.status).toBe(200);
    const command = RelayCommandSchema.parse(poll.body);
    expect(command.kind).toBe('execute');
    if (command.kind !== 'execute') throw new Error('expected execute command');
    expect(command.request).toMatchObject({
      requestId: FIRST_REQUEST_ID,
      operation: 'sandbox.eval',
      source: '(+ 40 2)',
      profile: PURE_PROFILE
    });

    const redelivered = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    expect(redelivered).toEqual(command);

    const acknowledged = RelayCommandSchema.parse(
      (
        await post(harness.baseUrl, '/v0/host/poll', {
          ...identity(host),
          waitMs: 0,
          acknowledgedCommandId: command.commandId
        })
      ).body
    );
    expect(acknowledged.kind).toBe('idle');

    const result = terminalResult(command.request, host);
    const submitted = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result
    });
    expect(submitted.status).toBe(200);
    expect(RelayAcceptedResponseSchema.parse(submitted.body)).toEqual({
      protocol: LOOPBACK_RELAY_PROTOCOL,
      accepted: true,
      duplicate: false
    });
    await expect(pending).resolves.toMatchObject({ status: 'completed', value: { text: '42', json: 42 } });

    const duplicate = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result
    });
    expect(RelayAcceptedResponseSchema.parse(duplicate.body).duplicate).toBe(true);

    const mutation = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: { ...result, value: { text: '43', json: 43 } }
    });
    expect(mutation.status).toBe(409);
    expect(RelayErrorResponseSchema.parse(mutation.body).error.code).toBe('terminal_collision');
  });

  it('wakes a bounded long poll when work becomes available', async () => {
    const harness = await startHarness();
    const host = descriptor();
    await registerHost(harness, host);
    const gateway = new HaraGateway(harness.registry, { idFactory: () => FIRST_REQUEST_ID });

    const pollPromise = post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = gateway.eval({ source: '(+ 40 2)' });
    const command = RelayCommandSchema.parse((await pollPromise).body);
    expect(command.kind).toBe('execute');
    if (command.kind !== 'execute') throw new Error('expected execute command');

    await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(command.request, host)
    });
    await expect(pending).resolves.toMatchObject({ status: 'completed' });
  });

  it('fences stale generations and manifest changes within one generation', async () => {
    const harness = await startHarness();
    const first = descriptor(1);
    await registerHost(harness, first);

    const stalePoll = await post(harness.baseUrl, '/v0/host/poll', {
      ...identity({ ...first, generation: 0 }),
      waitMs: 0
    });
    expect(stalePoll.status).toBe(409);
    expect(RelayErrorResponseSchema.parse(stalePoll.body).error.code).toBe('host_generation_stale');

    const changedManifest = await post(harness.baseUrl, '/v0/host/register', {
      protocol: LOOPBACK_RELAY_PROTOCOL,
      descriptor: { ...first, backend: 'changed-without-generation' }
    });
    expect(changedManifest.status).toBe(409);
    expect(RelayErrorResponseSchema.parse(changedManifest.body).error.code).toBe('host_manifest_changed');

    const second = descriptor(2);
    await registerHost(harness, second);
    const oldGeneration = await post(harness.baseUrl, '/v0/host/poll', { ...identity(first), waitMs: 0 });
    expect(oldGeneration.status).toBe(409);
    expect(RelayErrorResponseSchema.parse(oldGeneration.body).error.code).toBe('host_generation_stale');
    await expect(harness.registry.list()).resolves.toMatchObject([{ generation: 2, state: 'ready' }]);
  });

  it('projects truthful offline state after heartbeat expiry and recovers on the same generation', async () => {
    const clock = new ManualClock();
    const harness = await startHarness({ clock, hostTtlMs: 100 });
    const host = descriptor();
    await registerHost(harness, host);
    const gateway = new HaraGateway(harness.registry);

    await expect(gateway.runtimeGet()).resolves.toMatchObject({ state: 'ready' });
    clock.advance(101);
    await expect(gateway.runtimeGet()).rejects.toMatchObject({ code: 'host_unavailable' });

    const healthResponse = await fetch(`${harness.baseUrl}/v0/health`);
    expect(RelayHealthResponseSchema.parse((await healthResponse.json()) as unknown)).toMatchObject({
      hostState: 'offline'
    });

    const reconnect = await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 });
    expect(RelayCommandSchema.parse(reconnect.body).kind).toBe('idle');
    await expect(gateway.runtimeGet()).resolves.toMatchObject({ state: 'ready' });
  });

  it('propagates cancellation as a separate host command and settles once', async () => {
    const harness = await startHarness({ cleanupGraceMs: 500 });
    const host = descriptor();
    await registerHost(harness, host);
    const controller = new AbortController();
    const gateway = new HaraGateway(harness.registry, { idFactory: () => FIRST_REQUEST_ID });
    const pending = gateway.eval({ source: '(+ 40 2)' }, controller.signal);

    const execute = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    expect(execute.kind).toBe('execute');
    if (execute.kind !== 'execute') throw new Error('expected execute command');

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await expect(harness.coordinator.cancel(FIRST_REQUEST_ID)).resolves.toBe(true);
    await expect(harness.coordinator.cancel(FIRST_REQUEST_ID)).resolves.toBe(true);

    const cancel = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    expect(cancel).toMatchObject({
      kind: 'cancel',
      requestId: FIRST_REQUEST_ID,
      reason: 'client-cancelled'
    });
    if (cancel.kind !== 'cancel') throw new Error('expected cancel command');

    const redeliveredCancel = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    expect(redeliveredCancel).toEqual(cancel);
    const afterAcknowledgement = RelayCommandSchema.parse(
      (
        await post(harness.baseUrl, '/v0/host/poll', {
          ...identity(host),
          waitMs: 0,
          acknowledgedCommandId: cancel.commandId
        })
      ).body
    );
    expect(afterAcknowledgement.kind).toBe('idle');

    const terminal = terminalResult(execute.request, host, { status: 'cancelled' });
    const response = await post(harness.baseUrl, '/v0/host/result', { ...identity(host), result: terminal });
    expect(RelayAcceptedResponseSchema.parse(response.body).duplicate).toBe(false);
    expect(harness.coordinator.health().activeRequest).toBe(false);
  });

  it('propagates deadline expiry as cancellation and rejects changed result evidence', async () => {
    const harness = await startHarness({ cleanupGraceMs: 500 });
    const host = descriptor();
    await registerHost(harness, host);
    const gateway = new HaraGateway(harness.registry, { idFactory: () => FIRST_REQUEST_ID });
    const pending = gateway.eval({ source: '(+ 40 2)', limits: { wallMs: 30 } });

    const execute = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    expect(execute.kind).toBe('execute');
    if (execute.kind !== 'execute') throw new Error('expected execute command');

    await expect(pending).rejects.toMatchObject({ code: 'timed_out' });
    const cancel = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    expect(cancel).toMatchObject({ kind: 'cancel', reason: 'deadline-exceeded' });

    const changed = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(execute.request, host, {
        status: 'timed-out',
        sourceDigest: digest('changed source')
      })
    });
    expect(changed.status).toBe(400);
    expect(RelayErrorResponseSchema.parse(changed.body).error.code).toBe('invalid_request');

    const correct = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(execute.request, host, { status: 'timed-out' })
    });
    expect(RelayAcceptedResponseSchema.parse(correct.body).duplicate).toBe(false);
    expect(harness.coordinator.health().activeRequest).toBe(false);
  });

  it('replays a retained exact terminal result and rejects request-ID content collisions', async () => {
    const harness = await startHarness();
    const host = descriptor();
    await registerHost(harness, host);
    const gateway = new HaraGateway(harness.registry, { idFactory: () => FIRST_REQUEST_ID });

    const first = gateway.eval({ source: '(+ 40 2)' });
    const execute = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    if (execute.kind !== 'execute') throw new Error('expected execute command');
    await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(execute.request, host)
    });
    const completed = await first;

    await expect(gateway.eval({ source: '(+ 40 2)' })).resolves.toEqual(completed);
    expect(harness.coordinator.health().activeRequest).toBe(false);
    await expect(gateway.eval({ source: '(+ 41 1)' })).rejects.toMatchObject({ code: 'request_invalid' });
  });

  it('rejects terminal status changes after cancellation and aggregate output overflow', async () => {
    const harness = await startHarness({ cleanupGraceMs: 500 });
    const host = descriptor();
    await registerHost(harness, host);
    const controller = new AbortController();
    const gateway = new HaraGateway(harness.registry, { idFactory: () => FIRST_REQUEST_ID });
    const pending = gateway.eval(
      {
        source: '(+ 40 2)',
        limits: { outputBytes: 1_024 }
      },
      controller.signal
    );
    const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    const execute = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    if (execute.kind !== 'execute') throw new Error('expected execute command');
    controller.abort();
    await rejection;

    const changedStatus = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(execute.request, host)
    });
    expect(changedStatus.status).toBe(400);
    expect(RelayErrorResponseSchema.parse(changedStatus.body).error.code).toBe('invalid_request');

    const cancelled = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(execute.request, host, { status: 'cancelled' })
    });
    expect(cancelled.status).toBe(200);

    const secondGateway = new HaraGateway(harness.registry, { idFactory: () => SECOND_REQUEST_ID });
    const oversized = secondGateway.eval({ source: '(str "small")', limits: { outputBytes: 128 } });
    void oversized.catch(() => undefined);
    const secondExecute = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 0 })).body
    );
    if (secondExecute.kind !== 'execute') throw new Error('expected execute command');
    const overflow = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(secondExecute.request, host, { text: 'x'.repeat(256), json: 42 })
    });
    expect(overflow.status).toBe(400);
    expect(RelayErrorResponseSchema.parse(overflow.body).error.code).toBe('invalid_request');
    await harness.coordinator.cancel(SECOND_REQUEST_ID);
    await expect(oversized).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('propagates MCP client cancellation through the tool handler to the relay host', async () => {
    const harness = await startHarness({ cleanupGraceMs: 500 });
    const host = descriptor();
    await registerHost(harness, host);
    const client = await connectMcpClient(harness.registry);
    const controller = new AbortController();
    const call = client.callTool(
      { name: 'hara_eval', arguments: { source: '(+ 40 2)' } },
      { signal: controller.signal, timeout: 5_000 }
    );
    const rejected = expect(call).rejects.toThrow();

    const execute = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(host), waitMs: 1_000 })).body
    );
    if (execute.kind !== 'execute') throw new Error('expected execute command');

    controller.abort();
    await rejected;
    const cancel = RelayCommandSchema.parse(
      (
        await post(harness.baseUrl, '/v0/host/poll', {
          ...identity(host),
          waitMs: 1_000,
          acknowledgedCommandId: execute.commandId
        })
      ).body
    );
    expect(cancel).toMatchObject({
      kind: 'cancel',
      requestId: execute.request.requestId,
      reason: 'client-cancelled'
    });

    await post(harness.baseUrl, '/v0/host/result', {
      ...identity(host),
      result: terminalResult(execute.request, host, { status: 'cancelled' })
    });
  });

  it('fails an in-flight request when a newer host generation replaces it', async () => {
    const harness = await startHarness();
    const first = descriptor(1);
    await registerHost(harness, first);
    const gateway = new HaraGateway(harness.registry, { idFactory: () => FIRST_REQUEST_ID });
    const pending = gateway.eval({ source: '(+ 40 2)' });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'host_unavailable' });

    const execute = RelayCommandSchema.parse(
      (await post(harness.baseUrl, '/v0/host/poll', { ...identity(first), waitMs: 0 })).body
    );
    expect(execute.kind).toBe('execute');

    const second = descriptor(2);
    await registerHost(harness, second);
    await rejection;

    if (execute.kind !== 'execute') throw new Error('expected execute command');
    const staleResult = await post(harness.baseUrl, '/v0/host/result', {
      ...identity(first),
      result: terminalResult(execute.request, first)
    });
    expect(staleResult.status).toBe(409);
    expect(RelayErrorResponseSchema.parse(staleResult.body).error.code).toBe('host_generation_stale');
  });
});
