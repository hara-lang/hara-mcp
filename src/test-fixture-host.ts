import { createHash } from 'node:crypto';

import type { ExecutionHostProtocol } from './gateway.js';
import {
  EXECUTION_HOST_PROTOCOL,
  EXECUTION_RESULT_PROTOCOL,
  HostDescriptorSchema,
  PURE_PROFILE,
  type Diagnostic,
  type ExecutionRequest,
  type ExecutionResult,
  type HostDescriptor,
  type JsonValue,
  type ValueProjection
} from './protocol.js';

interface DeterministicTestHostOptions {
  now?: () => Date;
  hostId?: string;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function valueProjection(text: string, json?: JsonValue): ValueProjection {
  return json === undefined ? { text } : { text, json };
}

/**
 * Test-only transport fixture. This is not a Hara evaluator and must never be
 * registered implicitly by a production server.
 */
export class DeterministicTestHost implements ExecutionHostProtocol {
  readonly #now: () => Date;
  readonly #hostId: string;
  readonly #runtimeBuild = digest('hara-mcp deterministic transport fixture');
  readonly #cancelled = new Set<string>();
  #closed = false;

  constructor(options: DeterministicTestHostOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#hostId = options.hostId ?? 'fixture.local';
  }

  async describe(): Promise<HostDescriptor> {
    return HostDescriptorSchema.parse({
      protocol: EXECUTION_HOST_PROTOCOL,
      hostId: this.#hostId,
      generation: 1,
      kind: 'test-fixture',
      state: this.#closed ? 'offline' : 'ready',
      backend: 'deterministic-fixture',
      runtimeBuild: this.#runtimeBuild,
      haraVersion: 'fixture-only',
      profiles: [PURE_PROFILE],
      operations: ['runtime.get', 'sandbox.eval', 'sandbox.call', 'sandbox.check'],
      limits: {
        maxSourceBytes: 65_536,
        maxOutputBytes: 1_048_576,
        maxWallMs: 30_000
      },
      observedAt: this.#now().toISOString()
    });
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (this.#closed) throw new Error('fixture host is closed');
    if (signal?.aborted || this.#cancelled.has(request.requestId)) {
      return this.#result(request, 'cancelled', null, [
        {
          code: 'fixture/cancelled',
          severity: 'error',
          message: 'The deterministic fixture request was cancelled.'
        }
      ]);
    }

    switch (request.operation) {
      case 'sandbox.eval':
        if (request.source.trim() === '(+ 40 2)') {
          return this.#result(request, 'completed', valueProjection('42', 42), []);
        }
        return this.#unsupported(request, 'The deterministic fixture recognizes only the exact form (+ 40 2).');

      case 'sandbox.call':
        if (
          request.namespace === 'example.core' &&
          request.symbol === 'add' &&
          request.arguments.length === 2 &&
          request.arguments[0] === 40 &&
          request.arguments[1] === 2
        ) {
          return this.#result(request, 'completed', valueProjection('42', 42), []);
        }
        return this.#unsupported(
          request,
          'The deterministic fixture recognizes only example.core/add with arguments [40, 2].'
        );

      case 'sandbox.check':
        return this.#result(request, 'completed', null, []);
    }

    throw new Error(`unsupported fixture operation: ${(request as { operation: string }).operation}`);
  }

  async cancel(requestId: string): Promise<boolean> {
    if (this.#closed) return false;
    const previousSize = this.#cancelled.size;
    this.#cancelled.add(requestId);
    return this.#cancelled.size !== previousSize;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelled.clear();
  }

  #unsupported(request: ExecutionRequest, message: string): ExecutionResult {
    return this.#result(request, 'failed', null, [
      {
        code: 'fixture/unsupported-request',
        severity: 'error',
        message
      }
    ]);
  }

  #result(
    request: ExecutionRequest,
    status: ExecutionResult['status'],
    value: ValueProjection | null,
    diagnostics: Diagnostic[]
  ): ExecutionResult {
    const startedAt = this.#now();
    const completedAt = this.#now();
    return {
      protocol: EXECUTION_RESULT_PROTOCOL,
      requestId: request.requestId,
      runId: `fixture:${request.requestId}`,
      status,
      value,
      stdout: '',
      stderr: '',
      diagnostics,
      runtime: {
        hostId: this.#hostId,
        hostGeneration: 1,
        backend: 'deterministic-fixture',
        runtimeBuild: this.#runtimeBuild,
        haraVersion: 'fixture-only'
      },
      evidence: {
        profile: PURE_PROFILE,
        sourceDigest: request.sourceDigest,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        elapsedMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        cleanup: 'completed'
      }
    };
  }
}
