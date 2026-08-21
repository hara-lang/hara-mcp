import { describe, expect, it } from 'vitest';

import {
  EXECUTION_HOST_PROTOCOL,
  EXECUTION_RESULT_PROTOCOL,
  ExecutionToolResponseSchema,
  PURE_PROFILE,
  RuntimeToolResponseSchema
} from '../src/protocol.js';

const HOST = {
  protocol: EXECUTION_HOST_PROTOCOL,
  hostId: 'fixture.local',
  generation: 1,
  kind: 'test-fixture',
  state: 'ready',
  backend: 'deterministic-fixture',
  runtimeBuild: `sha256:${'0'.repeat(64)}`,
  haraVersion: 'fixture-only',
  profiles: [PURE_PROFILE],
  operations: ['runtime.get', 'sandbox.eval', 'sandbox.call', 'sandbox.check'],
  limits: {
    maxSourceBytes: 65_536,
    maxOutputBytes: 1_048_576,
    maxWallMs: 30_000
  },
  observedAt: '2026-08-21T00:00:00.000Z'
} as const;

const RESULT = {
  protocol: EXECUTION_RESULT_PROTOCOL,
  requestId: '00000000-0000-4000-8000-000000000001',
  runId: 'fixture:00000000-0000-4000-8000-000000000001',
  status: 'completed',
  value: { text: '42', json: 42 },
  stdout: '',
  stderr: '',
  diagnostics: [],
  runtime: {
    hostId: 'fixture.local',
    hostGeneration: 1,
    backend: 'deterministic-fixture',
    runtimeBuild: `sha256:${'0'.repeat(64)}`,
    haraVersion: 'fixture-only'
  },
  evidence: {
    profile: PURE_PROFILE,
    sourceDigest: `sha256:${'1'.repeat(64)}`,
    startedAt: '2026-08-21T00:00:00.000Z',
    completedAt: '2026-08-21T00:00:00.001Z',
    elapsedMs: 1,
    cleanup: 'completed'
  }
} as const;

describe('closed MCP response schemas', () => {
  it('accepts the exact runtime success shape', () => {
    expect(RuntimeToolResponseSchema.parse({ ok: true, host: HOST })).toEqual({ ok: true, host: HOST });
  });

  it('rejects extra fields inside the host descriptor', () => {
    expect(() =>
      RuntimeToolResponseSchema.parse({
        ok: true,
        host: { ...HOST, browserAuthority: true }
      })
    ).toThrow();
  });

  it('rejects a success response that also contains an error', () => {
    expect(() =>
      ExecutionToolResponseSchema.parse({
        ok: true,
        result: RESULT,
        error: { code: 'internal_error', message: 'should not coexist with success' }
      })
    ).toThrow();
  });

  it('rejects extra fields inside a nested execution result', () => {
    expect(() =>
      ExecutionToolResponseSchema.parse({
        ok: true,
        result: { ...RESULT, nativeHandle: 'forbidden' }
      })
    ).toThrow();
  });
});
