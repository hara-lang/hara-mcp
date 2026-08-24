import { describe, expect, it } from 'vitest';

import {
  HOST_SOCKET_PRODUCTION_URL,
  HOST_SOCKET_PROTOCOL,
  HOST_SOCKET_SUBPROTOCOL
} from '../src/host-socket-protocol.js';
import {
  HOSTED_RELAY_DISABLED_DEPLOYMENT,
  HOSTED_RELAY_HTTPS_ROUTE_URL,
  HostedHostSocketRelay,
  type HostedRelayDurableState,
  type HostedRelayPrincipal,
  type HostedRelayStateStore,
  routeHostedRelayUpgrade
} from '../src/host-socket-relay.js';
import {
  EXECUTION_HOST_PROTOCOL,
  EXECUTION_RESULT_PROTOCOL,
  PURE_PROFILE,
  type ExecutionRequest,
  type ExecutionResult,
  type HostDescriptor
} from '../src/protocol.js';

const NOW = new Date('2026-08-24T00:00:00.000Z');
const HOST_ID = 'hara.chrome.hosted';
const GENERATION = 7;
const EPOCH = '10000000-0000-4000-8000-000000000000';
const NEXT_EPOCH = '10000000-0000-4000-8000-000000000001';
const REQUEST_ID = '20000000-0000-4000-8000-000000000000';
const MANIFEST_DIGEST = `sha256:${'3'.repeat(64)}`;
const RUNTIME_DIGEST = `sha256:${'1'.repeat(64)}`;
const SOURCE_DIGEST = `sha256:${'2'.repeat(64)}`;

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class MemoryStateStore implements HostedRelayStateStore {
  value: HostedRelayDurableState | null = null;
  saves = 0;

  async load(): Promise<unknown | null> {
    return this.value === null ? null : jsonClone(this.value);
  }

  async save(state: HostedRelayDurableState): Promise<void> {
    this.value = jsonClone(state);
    this.saves += 1;
  }
}

function messageIds() {
  let sequence = 1;
  return () => `90000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
}

function relay(store = new MemoryStateStore()) {
  return new HostedHostSocketRelay(store, {
    now: () => new Date(NOW),
    messageId: messageIds(),
    heartbeatTtlMs: 5_000
  });
}

function descriptor(overrides: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    protocol: EXECUTION_HOST_PROTOCOL,
    hostId: HOST_ID,
    generation: GENERATION,
    kind: 'browser-wasm',
    state: 'ready',
    backend: 'raw-wasm',
    runtimeBuild: RUNTIME_DIGEST,
    haraVersion: 'hara-raw-wasm/0-alpha',
    profiles: [PURE_PROFILE],
    operations: ['runtime.get', 'sandbox.eval'],
    limits: {
      maxSourceBytes: 65_536,
      maxOutputBytes: 1_048_576,
      maxWallMs: 30_000
    },
    observedAt: NOW.toISOString(),
    ...overrides
  };
}

type EvalRequest = Extract<ExecutionRequest, { operation: 'sandbox.eval' }>;

function request(overrides: Partial<EvalRequest> = {}): EvalRequest {
  return {
    protocol: EXECUTION_HOST_PROTOCOL,
    requestId: REQUEST_ID,
    operation: 'sandbox.eval',
    profile: PURE_PROFILE,
    source: '(+ 40 2)',
    sourceDigest: SOURCE_DIGEST,
    limits: {
      wallMs: 5_000,
      outputBytes: 262_144
    },
    ...overrides
  };
}

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    protocol: EXECUTION_RESULT_PROTOCOL,
    requestId: REQUEST_ID,
    runId: `hosted:${REQUEST_ID}`,
    status: 'completed',
    value: { text: '42', json: 42 },
    stdout: '',
    stderr: '',
    diagnostics: [],
    runtime: {
      hostId: HOST_ID,
      hostGeneration: GENERATION,
      backend: 'raw-wasm',
      runtimeBuild: RUNTIME_DIGEST,
      haraVersion: 'hara-raw-wasm/0-alpha'
    },
    evidence: {
      profile: PURE_PROFILE,
      sourceDigest: SOURCE_DIGEST,
      startedAt: NOW.toISOString(),
      completedAt: new Date(NOW.valueOf() + 1).toISOString(),
      elapsedMs: 1,
      cleanup: 'completed'
    },
    ...overrides
  };
}

function principal(overrides: Partial<HostedRelayPrincipal> = {}): HostedRelayPrincipal {
  return {
    hostId: HOST_ID,
    generation: GENERATION,
    manifestDigest: MANIFEST_DIGEST,
    audience: HOST_SOCKET_PRODUCTION_URL,
    expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
    ...overrides
  };
}

function hello({
  messageId = '30000000-0000-4000-8000-000000000000',
  connectionEpoch = EPOCH,
  resumeAfter = -1,
  descriptorValue = descriptor(),
  manifestDigest = MANIFEST_DIGEST
} = {}) {
  return {
    protocol: HOST_SOCKET_PROTOCOL,
    kind: 'hello' as const,
    messageId,
    connectionEpoch,
    hostId: descriptorValue.hostId,
    generation: descriptorValue.generation,
    descriptor: descriptorValue,
    manifestDigest,
    resumeAfter
  };
}

function ackFrame(
  offer: { sequence: number; commandId: string },
  messageId = '40000000-0000-4000-8000-000000000000',
  connectionEpoch = EPOCH
) {
  return {
    protocol: HOST_SOCKET_PROTOCOL,
    kind: 'ack' as const,
    messageId,
    connectionEpoch,
    hostId: HOST_ID,
    generation: GENERATION,
    relaySequence: offer.sequence,
    commandId: offer.commandId
  };
}

function resultFrame(
  offer: { sequence: number; commandId: string },
  terminal: ExecutionResult = result(),
  messageId = '50000000-0000-4000-8000-000000000000',
  connectionEpoch = EPOCH
) {
  return {
    protocol: HOST_SOCKET_PROTOCOL,
    kind: 'result' as const,
    messageId,
    connectionEpoch,
    hostId: HOST_ID,
    generation: GENERATION,
    relaySequence: offer.sequence,
    commandId: offer.commandId,
    result: terminal
  };
}

const ENABLED_DEPLOYMENT = Object.freeze({
  ...HOSTED_RELAY_DISABLED_DEPLOYMENT,
  enabled: true
});

const UPGRADE = Object.freeze({
  method: 'GET',
  url: HOSTED_RELAY_HTTPS_ROUTE_URL,
  upgrade: 'websocket',
  subprotocol: HOST_SOCKET_SUBPROTOCOL
});

describe('hosted relay deployment gate', () => {
  it('remains disabled by default and accepts only the exact enrolled production upgrade', () => {
    expect(() => routeHostedRelayUpgrade(UPGRADE, principal())).toThrowError(
      expect.objectContaining({ code: 'host_relay_disabled', status: 503 })
    );

    const decision = routeHostedRelayUpgrade(UPGRADE, principal(), ENABLED_DEPLOYMENT, () => new Date(NOW));
    expect(decision).toEqual({
      accepted: true,
      objectName: HOST_ID,
      responseSubprotocol: HOST_SOCKET_SUBPROTOCOL,
      principal: principal()
    });
    expect(JSON.stringify(decision)).not.toMatch(/bearer|token|secret/i);
  });

  it('rejects alternate routes, protocol lists, missing enrollment and expired principals', () => {
    for (const changed of [
      { ...UPGRADE, method: 'POST' },
      { ...UPGRADE, url: `${HOSTED_RELAY_HTTPS_ROUTE_URL}/` },
      { ...UPGRADE, url: `${HOSTED_RELAY_HTTPS_ROUTE_URL}?token=secret` },
      { ...UPGRADE, upgrade: null },
      { ...UPGRADE, subprotocol: `${HOST_SOCKET_SUBPROTOCOL}, other` }
    ]) {
      expect(() => routeHostedRelayUpgrade(changed, principal(), ENABLED_DEPLOYMENT, () => new Date(NOW))).toThrow();
    }

    expect(() => routeHostedRelayUpgrade(UPGRADE, null, ENABLED_DEPLOYMENT, () => new Date(NOW))).toThrowError(
      expect.objectContaining({ code: 'host_authentication_required' })
    );
    expect(() =>
      routeHostedRelayUpgrade(
        UPGRADE,
        principal({ expiresAt: NOW.toISOString() }),
        ENABLED_DEPLOYMENT,
        () => new Date(NOW)
      )
    ).toThrowError(expect.objectContaining({ code: 'host_authorization_expired' }));
  });
});

describe('durable hosted host lifecycle', () => {
  it('persists hello, offer, acknowledgement and immutable terminal settlement', async () => {
    const store = new MemoryStateStore();
    const coordinator = relay(store);

    const ready = await coordinator.acceptHello(hello(), principal());
    expect(ready).toMatchObject({ kind: 'ready', sequence: 0, resumeAccepted: false });

    const offer = await coordinator.issueOffer(request());
    expect(offer).toMatchObject({
      kind: 'offer',
      sequence: 1,
      commandId: `relay:${REQUEST_ID}:execute`
    });

    const acceptedAck = await coordinator.handleHostFrame(ackFrame(offer));
    expect(acceptedAck).toMatchObject({ kind: 'accepted', sequence: 2, duplicate: false });

    const acceptedResult = await coordinator.handleHostFrame(resultFrame(offer));
    expect(acceptedResult).toMatchObject({ kind: 'accepted', sequence: 3, duplicate: false });
    expect(await coordinator.retainedResult(REQUEST_ID)).toEqual(result());

    const duplicate = await coordinator.handleHostFrame(
      resultFrame(offer, result(), '50000000-0000-4000-8000-000000000001')
    );
    expect(duplicate).toMatchObject({ kind: 'accepted', sequence: 4, duplicate: true });

    await expect(
      coordinator.handleHostFrame(
        resultFrame(offer, result({ value: { text: '43', json: 43 } }), '50000000-0000-4000-8000-000000000002')
      )
    ).rejects.toMatchObject({ code: 'host_terminal_collision' });

    const snapshot = await coordinator.snapshot();
    expect(snapshot).toMatchObject({
      connected: true,
      activeRequestId: null,
      terminalCount: 1,
      lastRelaySequence: 4
    });
    expect(JSON.stringify(snapshot)).not.toContain('(+ 40 2)');
    expect(store.saves).toBeGreaterThanOrEqual(5);
  });

  it('returns the exact prior response for identical host-message redelivery and rejects changed reuse', async () => {
    const coordinator = relay();
    await coordinator.acceptHello(hello(), principal());
    const offer = await coordinator.issueOffer(request());
    const ack = ackFrame(offer);

    const first = await coordinator.handleHostFrame(ack);
    const duplicate = await coordinator.handleHostFrame(ack);
    expect(duplicate).toEqual(first);
    expect((await coordinator.snapshot()).lastRelaySequence).toBe(first.sequence);

    await expect(
      coordinator.handleHostFrame({
        ...ack,
        relaySequence: offer.sequence + 1
      })
    ).rejects.toMatchObject({ code: 'host_message_collision' });
  });

  it('requires resynchronisation rather than replaying an acknowledged execution after reconnect', async () => {
    const coordinator = relay();
    await coordinator.acceptHello(hello(), principal());
    const offer = await coordinator.issueOffer(request());
    const accepted = await coordinator.handleHostFrame(ackFrame(offer));
    await coordinator.markDisconnected(EPOCH);

    const reconnect = await coordinator.acceptHello(
      hello({
        messageId: '30000000-0000-4000-8000-000000000001',
        connectionEpoch: NEXT_EPOCH,
        resumeAfter: accepted.sequence
      }),
      principal()
    );
    expect(reconnect).toMatchObject({
      kind: 'resync-required',
      reason: 'connection-replaced',
      sequence: accepted.sequence + 1
    });
    await expect(coordinator.redeliverPending()).rejects.toMatchObject({ code: 'host_connection_unavailable' });
    expect((await coordinator.snapshot()).activeRequestId).toBe(REQUEST_ID);
  });

  it('redelivers an unacknowledged command with the stable command ID after an exact resume', async () => {
    const coordinator = relay();
    await coordinator.acceptHello(hello(), principal());
    const firstOffer = await coordinator.issueOffer(request());
    await coordinator.markDisconnected(EPOCH);

    const ready = await coordinator.acceptHello(
      hello({
        messageId: '30000000-0000-4000-8000-000000000002',
        connectionEpoch: NEXT_EPOCH,
        resumeAfter: firstOffer.sequence
      }),
      principal()
    );
    expect(ready).toMatchObject({ kind: 'ready', sequence: firstOffer.sequence + 1, resumeAccepted: true });

    const redelivery = await coordinator.redeliverPending();
    expect(redelivery).toMatchObject({
      kind: 'offer',
      sequence: ready.sequence + 1,
      commandId: firstOffer.commandId,
      request: request()
    });
  });

  it('binds cancellation acknowledgement and terminal status to the active request', async () => {
    const coordinator = relay();
    await coordinator.acceptHello(hello(), principal());
    const offer = await coordinator.issueOffer(request());
    const cancel = await coordinator.issueCancel(REQUEST_ID, 'deadline-exceeded');
    expect(cancel).toMatchObject({
      kind: 'cancel',
      commandId: `relay:${REQUEST_ID}:cancel`,
      reason: 'deadline-exceeded'
    });
    await coordinator.handleHostFrame(ackFrame(cancel, '40000000-0000-4000-8000-000000000001'));

    await expect(
      coordinator.handleHostFrame(resultFrame(offer, result(), '50000000-0000-4000-8000-000000000003'))
    ).rejects.toMatchObject({ code: 'host_result_invalid' });

    const timedOut = result({
      status: 'timed-out',
      value: null,
      diagnostics: [
        {
          code: 'remote/timed-out',
          severity: 'warning',
          message: 'deadline exceeded'
        }
      ]
    });
    const accepted = await coordinator.handleHostFrame(
      resultFrame(offer, timedOut, '50000000-0000-4000-8000-000000000004')
    );
    expect(accepted).toMatchObject({ kind: 'accepted', duplicate: false });
  });

  it('rejects stale generations and same-generation manifest changes', async () => {
    const coordinator = relay();
    await coordinator.acceptHello(hello(), principal());

    const changedManifest = `sha256:${'4'.repeat(64)}`;
    await expect(
      coordinator.acceptHello(
        hello({
          messageId: '30000000-0000-4000-8000-000000000003',
          manifestDigest: changedManifest
        }),
        principal({ manifestDigest: changedManifest })
      )
    ).rejects.toMatchObject({ code: 'host_manifest_changed' });

    const staleDescriptor = descriptor({ generation: GENERATION - 1 });
    await expect(
      coordinator.acceptHello(
        hello({
          messageId: '30000000-0000-4000-8000-000000000004',
          descriptorValue: staleDescriptor
        }),
        principal({ generation: GENERATION - 1 })
      )
    ).rejects.toMatchObject({ code: 'host_identity_stale' });
  });
});
