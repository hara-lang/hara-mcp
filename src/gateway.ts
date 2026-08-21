import { createHash, randomUUID } from 'node:crypto';

import {
  CallHostRequestSchema,
  CheckHostRequestSchema,
  DEFAULT_LIMITS,
  EvalHostRequestSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  HostDescriptorSchema,
  PURE_PROFILE,
  SERVER_MAX_LIMITS,
  type CallToolInput,
  type CheckToolInput,
  type EffectiveLimits,
  type EvalToolInput,
  type ExecutionOperation,
  type ExecutionRequest,
  type ExecutionResult,
  type GatewayErrorCode,
  type HostDescriptor,
  type RequestedLimits
} from './protocol.js';

export interface ExecutionHostProtocol {
  describe(): Promise<HostDescriptor>;
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
  cancel(requestId: string): Promise<boolean>;
  close(): Promise<void>;
}

interface RegisteredHost {
  host: ExecutionHostProtocol;
  descriptor: HostDescriptor;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
  }
}

export class InMemoryHostRegistry {
  readonly #hosts = new Map<string, RegisteredHost>();

  async register(host: ExecutionHostProtocol): Promise<HostDescriptor> {
    const descriptor = HostDescriptorSchema.parse(await host.describe());
    if (this.#hosts.has(descriptor.hostId)) {
      throw new GatewayError('host_collision', `host ${descriptor.hostId} is already registered`);
    }
    this.#hosts.set(descriptor.hostId, { host, descriptor });
    return descriptor;
  }

  async list(): Promise<HostDescriptor[]> {
    const descriptors: HostDescriptor[] = [];
    for (const [hostId, entry] of this.#hosts) {
      const descriptor = HostDescriptorSchema.parse(await entry.host.describe());
      this.#hosts.set(hostId, { ...entry, descriptor });
      descriptors.push(descriptor);
    }
    return descriptors.sort((left, right) => left.hostId.localeCompare(right.hostId));
  }

  async select(operation: ExecutionOperation): Promise<RegisteredHost> {
    const entries = [...this.#hosts.values()].sort((left, right) =>
      left.descriptor.hostId.localeCompare(right.descriptor.hostId)
    );

    if (entries.length === 0) {
      throw new GatewayError('host_unavailable', 'no Hara execution host is registered');
    }

    let sawReadyHost = false;
    for (const entry of entries) {
      const descriptor = HostDescriptorSchema.parse(await entry.host.describe());
      entry.descriptor = descriptor;
      if (descriptor.state !== 'ready') continue;
      sawReadyHost = true;
      if (!descriptor.profiles.includes(PURE_PROFILE)) continue;
      if (!descriptor.operations.includes(operation)) continue;
      return entry;
    }

    if (!sawReadyHost) {
      throw new GatewayError('host_unavailable', 'no registered Hara execution host is currently ready');
    }

    throw new GatewayError(
      'host_incompatible',
      `no ready Hara execution host advertises ${PURE_PROFILE} with operation ${operation}`
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#hosts.values()].map(({ host }) => host.close()));
    this.#hosts.clear();
  }
}

interface GatewayOptions {
  idFactory?: () => string;
}

function sourceDigest(source: string | undefined): string {
  return `sha256:${createHash('sha256')
    .update(source ?? '', 'utf8')
    .digest('hex')}`;
}

function byteLength(source: string | undefined): number {
  return Buffer.byteLength(source ?? '', 'utf8');
}

function effectiveLimits(requested: RequestedLimits | undefined, descriptor: HostDescriptor): EffectiveLimits {
  const limits = {
    wallMs: requested?.wallMs ?? DEFAULT_LIMITS.wallMs,
    outputBytes: requested?.outputBytes ?? DEFAULT_LIMITS.outputBytes
  };

  if (limits.wallMs > descriptor.limits.maxWallMs) {
    throw new GatewayError(
      'limit_exceeded',
      `requested wall time ${limits.wallMs}ms exceeds host maximum ${descriptor.limits.maxWallMs}ms`
    );
  }
  if (limits.outputBytes > descriptor.limits.maxOutputBytes) {
    throw new GatewayError(
      'limit_exceeded',
      `requested output bound ${limits.outputBytes} bytes exceeds host maximum ${descriptor.limits.maxOutputBytes} bytes`
    );
  }

  return limits;
}

export class HaraGateway {
  readonly #registry: InMemoryHostRegistry;
  readonly #idFactory: () => string;

  constructor(registry: InMemoryHostRegistry, options: GatewayOptions = {}) {
    this.#registry = registry;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async runtimeGet(): Promise<HostDescriptor> {
    const { descriptor } = await this.#registry.select('runtime.get');
    return descriptor;
  }

  async eval(input: EvalToolInput, signal?: AbortSignal): Promise<ExecutionResult> {
    const selected = await this.#registry.select('sandbox.eval');
    this.#assertSourceBound(input.source, selected.descriptor);
    const request = EvalHostRequestSchema.parse({
      protocol: selected.descriptor.protocol,
      requestId: this.#idFactory(),
      operation: 'sandbox.eval',
      profile: PURE_PROFILE,
      source: input.source,
      sourceDigest: sourceDigest(input.source),
      limits: effectiveLimits(input.limits, selected.descriptor)
    });
    return await this.#execute(selected, request, signal);
  }

  async call(input: CallToolInput, signal?: AbortSignal): Promise<ExecutionResult> {
    const selected = await this.#registry.select('sandbox.call');
    this.#assertSourceBound(input.source, selected.descriptor);
    const request = CallHostRequestSchema.parse({
      protocol: selected.descriptor.protocol,
      requestId: this.#idFactory(),
      operation: 'sandbox.call',
      profile: PURE_PROFILE,
      namespace: input.namespace,
      symbol: input.symbol,
      arguments: input.arguments,
      ...(input.source === undefined ? {} : { source: input.source }),
      sourceDigest: sourceDigest(input.source),
      limits: effectiveLimits(input.limits, selected.descriptor)
    });
    return await this.#execute(selected, request, signal);
  }

  async check(input: CheckToolInput, signal?: AbortSignal): Promise<ExecutionResult> {
    const selected = await this.#registry.select('sandbox.check');
    this.#assertSourceBound(input.source, selected.descriptor);
    const request = CheckHostRequestSchema.parse({
      protocol: selected.descriptor.protocol,
      requestId: this.#idFactory(),
      operation: 'sandbox.check',
      profile: PURE_PROFILE,
      source: input.source,
      sourceDigest: sourceDigest(input.source),
      checkProfile: input.profile,
      limits: effectiveLimits(input.limits, selected.descriptor)
    });
    return await this.#execute(selected, request, signal);
  }

  #assertSourceBound(source: string | undefined, descriptor: HostDescriptor): void {
    const size = byteLength(source);
    if (size > SERVER_MAX_LIMITS.sourceBytes) {
      throw new GatewayError(
        'limit_exceeded',
        `source is ${size} bytes, above the server maximum ${SERVER_MAX_LIMITS.sourceBytes} bytes`
      );
    }
    if (size > descriptor.limits.maxSourceBytes) {
      throw new GatewayError(
        'limit_exceeded',
        `source is ${size} bytes, above host maximum ${descriptor.limits.maxSourceBytes} bytes`
      );
    }
  }

  async #execute(selected: RegisteredHost, request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const validatedRequest = ExecutionRequestSchema.parse(request);
    const rawResult = await selected.host.execute(validatedRequest, signal);
    const result = ExecutionResultSchema.parse(rawResult);

    if (result.requestId !== validatedRequest.requestId) {
      throw new GatewayError('host_result_invalid', 'execution host returned a result for another request');
    }
    if (result.runtime.hostId !== selected.descriptor.hostId) {
      throw new GatewayError('host_result_invalid', 'execution host result changed the selected host identity');
    }
    if (result.runtime.hostGeneration !== selected.descriptor.generation) {
      throw new GatewayError('host_result_invalid', 'execution host result changed the selected host generation');
    }
    if (result.evidence.profile !== PURE_PROFILE) {
      throw new GatewayError('host_result_invalid', 'execution host result changed the sandbox profile');
    }
    if (result.evidence.sourceDigest !== validatedRequest.sourceDigest) {
      throw new GatewayError('host_result_invalid', 'execution host result changed the source digest');
    }

    return result;
  }
}
