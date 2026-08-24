import { describe, expect, it } from 'vitest';

import {
  HOST_SOCKET_MAX_FRAME_BYTES,
  HOST_SOCKET_PRODUCTION_URL,
  HOST_SOCKET_PROTOCOL,
  HOST_SOCKET_SUBPROTOCOL,
  HostSocketProtocolError,
  HostSocketSequenceFence,
  decodeHostSocketFrame,
  encodeHostSocketFrame,
  parseHostSocketFrame,
  parseHostToRelayFrame,
  parseRelayToHostFrame,
  validateHostSocketSubprotocol,
  validateHostSocketUrl
} from '../src/host-socket-protocol.js';
import { EXECUTION_HOST_PROTOCOL, EXECUTION_RESULT_PROTOCOL, PURE_PROFILE } from '../src/protocol.js';

const EPOCH = '10000000-0000-4000-8000-000000000000';
const HOST_ID = 'hara.chrome.hosted';
const GENERATION = 7;
const REQUEST_ID = '20000000-0000-4000-8000-000000000000';

const DESCRIPTOR = {
  protocol: EXECUTION_HOST_PROTOCOL,
  hostId: HOST_ID,
  generation: GENERATION,
  kind: 'browser-wasm',
  state: 'ready',
  backend: 'raw-wasm',
  runtimeBuild: `sha256:${'1'.repeat(64)}`,
  haraVersion: 'hara-raw-wasm/0-alpha',
  profiles: [PURE_PROFILE],
  operations: ['runtime.get', 'sandbox.eval'],
  limits: {
    maxSourceBytes: 65_536,
    maxOutputBytes: 1_048_576,
    maxWallMs: 30_000
  },
  observedAt: '2026-08-24T01:00:00.000Z'
} as const;

const REQUEST = {
  protocol: EXECUTION_HOST_PROTOCOL,
  requestId: REQUEST_ID,
  operation: 'sandbox.eval',
  profile: PURE_PROFILE,
  source: '(+ 40 2)',
  sourceDigest: `sha256:${'2'.repeat(64)}`,
  limits: {
    wallMs: 5_000,
    outputBytes: 262_144
  }
} as const;

const RESULT = {
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
    runtimeBuild: `sha256:${'1'.repeat(64)}`,
    haraVersion: 'hara-raw-wasm/0-alpha'
  },
  evidence: {
    profile: PURE_PROFILE,
    sourceDigest: `sha256:${'2'.repeat(64)}`,
    startedAt: '2026-08-24T01:00:00.000Z',
    completedAt: '2026-08-24T01:00:00.001Z',
    elapsedMs: 1,
    cleanup: 'completed'
  }
} as const;

const HELLO = {
  protocol: HOST_SOCKET_PROTOCOL,
  kind: 'hello',
  messageId: '30000000-0000-4000-8000-000000000001',
  connectionEpoch: EPOCH,
  hostId: HOST_ID,
  generation: GENERATION,
  descriptor: DESCRIPTOR,
  manifestDigest: `sha256:${'3'.repeat(64)}`,
  resumeAfter: -1
} as const;

const READY = {
  protocol: HOST_SOCKET_PROTOCOL,
  kind: 'ready',
  messageId: '30000000-0000-4000-8000-000000000002',
  connectionEpoch: EPOCH,
  hostId: HOST_ID,
  generation: GENERATION,
  sequence: 0,
  inReplyTo: HELLO.messageId,
  heartbeatTtlMs: 5_000,
  resumeAccepted: false
} as const;

const OFFER = {
  protocol: HOST_SOCKET_PROTOCOL,
  kind: 'offer',
  messageId: '30000000-0000-4000-8000-000000000003',
  connectionEpoch: EPOCH,
  hostId: HOST_ID,
  generation: GENERATION,
  sequence: 1,
  commandId: `relay:${REQUEST_ID}:execute`,
  request: REQUEST
} as const;

const ACK = {
  protocol: HOST_SOCKET_PROTOCOL,
  kind: 'ack',
  messageId: '30000000-0000-4000-8000-000000000004',
  connectionEpoch: EPOCH,
  hostId: HOST_ID,
  generation: GENERATION,
  relaySequence: OFFER.sequence,
  commandId: OFFER.commandId
} as const;

const RESULT_FRAME = {
  protocol: HOST_SOCKET_PROTOCOL,
  kind: 'result',
  messageId: '30000000-0000-4000-8000-000000000005',
  connectionEpoch: EPOCH,
  hostId: HOST_ID,
  generation: GENERATION,
  relaySequence: OFFER.sequence,
  commandId: OFFER.commandId,
  result: RESULT
} as const;

describe('host socket endpoint contract', () => {
  it('accepts only the exact production endpoint', () => {
    expect(validateHostSocketUrl(HOST_SOCKET_PRODUCTION_URL, 'production')).toBe(HOST_SOCKET_PRODUCTION_URL);

    for (const value of [
      'wss://mcp.hara-lang.org/relay/host/v1/',
      'wss://relay.hara-lang.org/host/v1',
      'ws://mcp.hara-lang.org/relay/host/v1',
      'https://mcp.hara-lang.org/relay/host/v1',
      'wss://mcp.hara-lang.org:443/relay/host/v1',
      'wss://user:secret@mcp.hara-lang.org/relay/host/v1',
      'wss://mcp.hara-lang.org/relay/host/v1?token=secret',
      'wss://mcp.hara-lang.org/relay/host/v1#fragment'
    ]) {
      expect(() => validateHostSocketUrl(value, 'production'), value).toThrow(HostSocketProtocolError);
    }
  });

  it('keeps explicit IPv4 loopback WebSocket development separate', () => {
    const local = 'ws://127.0.0.1:8765/relay/host/v1';
    expect(validateHostSocketUrl(local, 'development')).toBe(local);

    for (const value of [
      'wss://127.0.0.1:8765/relay/host/v1',
      'ws://localhost:8765/relay/host/v1',
      'ws://0.0.0.0:8765/relay/host/v1',
      'ws://[::1]:8765/relay/host/v1',
      'ws://127.0.0.1/relay/host/v1',
      'ws://127.0.0.1:8765/',
      'ws://127.0.0.1:8765/relay/host/v1?token=secret'
    ]) {
      expect(() => validateHostSocketUrl(value, 'development'), value).toThrow(HostSocketProtocolError);
    }
  });

  it('negotiates one exact WebSocket subprotocol', () => {
    expect(validateHostSocketSubprotocol(HOST_SOCKET_SUBPROTOCOL)).toBe(HOST_SOCKET_SUBPROTOCOL);
    expect(() => validateHostSocketSubprotocol('hara.host.v0')).toThrow(HostSocketProtocolError);
    expect(() => validateHostSocketSubprotocol('hara.host.v1, bearer-secret')).toThrow(HostSocketProtocolError);
  });
});

describe('closed host socket frames', () => {
  it('round-trips the hello, ready, offer, acknowledgement and result frames', () => {
    for (const frame of [HELLO, READY, OFFER, ACK, RESULT_FRAME]) {
      expect(decodeHostSocketFrame(encodeHostSocketFrame(frame))).toEqual(frame);
    }
    expect(parseHostToRelayFrame(HELLO)).toEqual(HELLO);
    expect(parseRelayToHostFrame(READY)).toEqual(READY);
  });

  it('rejects credentials and unknown authority fields in every frame', () => {
    expect(() => parseHostSocketFrame({ ...HELLO, token: 'device-secret' })).toThrow(HostSocketProtocolError);
    expect(() => parseHostSocketFrame({ ...OFFER, mcpBearer: 'client-secret' })).toThrow(HostSocketProtocolError);
    expect(() => parseHostSocketFrame({ ...RESULT_FRAME, browserAuthority: true })).toThrow(
      HostSocketProtocolError
    );
  });

  it('binds hello and terminal frames to the exact host generation', () => {
    expect(() =>
      parseHostSocketFrame({
        ...HELLO,
        generation: GENERATION + 1
      })
    ).toThrowError(expect.objectContaining({ code: 'host_socket_host_identity_stale' }));

    expect(() =>
      parseHostSocketFrame({
        ...RESULT_FRAME,
        generation: GENERATION + 1
      })
    ).toThrowError(expect.objectContaining({ code: 'host_socket_host_identity_stale' }));
  });

  it('accepts text JSON only and enforces a smaller application frame bound', () => {
    expect(() => decodeHostSocketFrame('{not-json')).toThrowError(
      expect.objectContaining({ code: 'host_socket_frame_invalid' })
    );
    expect(() => decodeHostSocketFrame('x'.repeat(HOST_SOCKET_MAX_FRAME_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: 'host_socket_frame_too_large' })
    );
  });
});

describe('connection epoch and relay sequence fencing', () => {
  it('permits identical redelivery but rejects changed, stale and skipped sequences', () => {
    const fence = new HostSocketSequenceFence({
      connectionEpoch: EPOCH,
      hostId: HOST_ID,
      generation: GENERATION
    });

    expect(fence.acceptRelayFrame(READY).duplicate).toBe(false);
    expect(fence.acceptRelayFrame(READY).duplicate).toBe(true);
    expect(() => fence.acceptRelayFrame({ ...READY, heartbeatTtlMs: 6_000 })).toThrowError(
      expect.objectContaining({ code: 'host_socket_sequence_collision' })
    );
    expect(() => fence.acceptRelayFrame({ ...OFFER, sequence: 2 })).toThrowError(
      expect.objectContaining({ code: 'host_socket_resync_required' })
    );
    expect(fence.acceptRelayFrame(OFFER).duplicate).toBe(false);
    expect(() => fence.acceptRelayFrame(READY)).toThrowError(
      expect.objectContaining({ code: 'host_socket_sequence_stale' })
    );
    expect(fence.snapshot()).toEqual({
      connectionEpoch: EPOCH,
      hostId: HOST_ID,
      generation: GENERATION,
      lastRelaySequence: 1
    });
  });

  it('rejects frames from a replaced connection epoch or stale host generation', () => {
    const fence = new HostSocketSequenceFence({
      connectionEpoch: EPOCH,
      hostId: HOST_ID,
      generation: GENERATION
    });

    expect(() =>
      fence.acceptRelayFrame({
        ...READY,
        connectionEpoch: '40000000-0000-4000-8000-000000000000'
      })
    ).toThrowError(expect.objectContaining({ code: 'host_socket_connection_epoch_stale' }));

    expect(() => fence.assertHostFrame({ ...ACK, generation: GENERATION - 1 })).toThrowError(
      expect.objectContaining({ code: 'host_socket_host_identity_stale' })
    );
  });
});
