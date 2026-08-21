import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GatewayError, type ExecutionHostProtocol } from './gateway.js';
import {
  LOOPBACK_RELAY_BIND_ADDRESS,
  LOOPBACK_RELAY_DEFAULT_HOST_TTL_MS,
  LOOPBACK_RELAY_DEFAULT_POLL_MS,
  LOOPBACK_RELAY_DEFAULT_PORT,
  LOOPBACK_RELAY_MAX_BODY_BYTES,
  LOOPBACK_RELAY_PROTOCOL,
  RelayAcceptedResponseSchema,
  RelayCommandSchema,
  RelayErrorResponseSchema,
  RelayHealthResponseSchema,
  RelayHostIdentitySchema,
  RelayPollRequestSchema,
  RelayRegisterRequestSchema,
  RelayRegisterResponseSchema,
  RelayResultRequestSchema,
  type RelayAcceptedResponse,
  type RelayCommand,
  type RelayErrorCode,
  type RelayHealthResponse,
  type RelayHostIdentity,
  type RelayPollRequest,
  type RelayRegisterRequest,
  type RelayRegisterResponse,
  type RelayResultRequest
} from './relay-protocol.js';
import {
  ExecutionRequestSchema,
  ExecutionResultSchema,
  HostDescriptorSchema,
  PURE_PROFILE,
  type ExecutionRequest,
  type ExecutionResult,
  type HostDescriptor
} from './protocol.js';

const DEFAULT_CLEANUP_GRACE_MS = 1_000;
const DEFAULT_TERMINAL_RECORD_LIMIT = 16;
const MAX_TERMINAL_RECORD_LIMIT = 128;
const LOOPBACK_RELAY_HEADERS_TIMEOUT_MS = 5_000;
const LOOPBACK_RELAY_REQUEST_TIMEOUT_MS = 10_000;
const LOOPBACK_RELAY_HOST_PATHS = new Set(['/v0/host/register', '/v0/host/poll', '/v0/host/result']);

type CancelReason = 'client-cancelled' | 'deadline-exceeded' | 'relay-closing';
type LocalTerminalStatus = 'cancelled' | 'timed_out' | 'host_unavailable' | 'relay_closed';

interface ActiveRun {
  request: ExecutionRequest;
  descriptor: HostDescriptor;
  executeCommandId: string;
  executeIssued: boolean;
  executeAcknowledged: boolean;
  cancelCommandId: string;
  cancelIssued: boolean;
  cancelAcknowledged: boolean;
  cancelReason: CancelReason | null;
  callerSettled: boolean;
  resolve: (result: ExecutionResult) => void;
  reject: (error: GatewayError) => void;
  deadlineTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
}

interface TerminalRecord {
  requestDigest: string;
  resultDigest: string | null;
  result: ExecutionResult | null;
  status: 'result' | LocalTerminalStatus;
}

export interface LoopbackRelayCoordinatorOptions {
  now?: () => Date;
  hostTtlMs?: number;
  pollAfterMs?: number;
  cleanupGraceMs?: number;
  terminalRecordLimit?: number;
  onFirstHost?: (host: ExecutionHostProtocol) => Promise<void>;
}

export interface LoopbackRelayServerOptions {
  pairingToken: string;
  bindAddress?: string;
  port?: number;
  allowedOrigin?: string;
  maxBodyBytes?: number;
}

export interface LoopbackRelayAddress {
  host: typeof LOOPBACK_RELAY_BIND_ADDRESS;
  port: number;
  url: string;
}

export class RelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function descriptorManifest(descriptor: HostDescriptor): string {
  return sha256Json({
    protocol: descriptor.protocol,
    hostId: descriptor.hostId,
    generation: descriptor.generation,
    kind: descriptor.kind,
    backend: descriptor.backend,
    runtimeBuild: descriptor.runtimeBuild,
    haraVersion: descriptor.haraVersion,
    profiles: descriptor.profiles,
    operations: descriptor.operations,
    limits: descriptor.limits
  });
}

function requestDigest(request: ExecutionRequest): string {
  return sha256Json(request);
}

function resultDigest(result: ExecutionResult): string {
  return sha256Json(result);
}

function relayCommandId(requestId: string, kind: 'execute' | 'cancel'): string {
  return `relay:${requestId}:${kind}`;
}

function resultOutputBytes(result: ExecutionResult): number {
  return Buffer.byteLength(
    JSON.stringify({
      value: result.value,
      stdout: result.stdout,
      stderr: result.stderr,
      diagnostics: result.diagnostics
    }),
    'utf8'
  );
}

function secureTokenEqual(expected: string, authorization: string | undefined): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  const actual = authorization.slice('Bearer '.length);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function firstValidationMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'invalid closed relay payload';
  const issues = (error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues;
  const issue = issues?.[0];
  if (issue === undefined) return error.message;
  const path = issue.path?.map(String).join('.') ?? '';
  return path.length === 0 ? (issue.message ?? error.message) : `${path}: ${issue.message ?? error.message}`;
}

export class LoopbackRelayCoordinator implements ExecutionHostProtocol {
  readonly #now: () => Date;
  readonly #hostTtlMs: number;
  readonly #pollAfterMs: number;
  readonly #cleanupGraceMs: number;
  readonly #terminalRecordLimit: number;
  readonly #onFirstHost: ((host: ExecutionHostProtocol) => Promise<void>) | null;
  readonly #pollWaiters = new Set<() => void>();
  readonly #terminals = new Map<string, TerminalRecord>();

  #activityVersion = 0;
  #descriptor: HostDescriptor | null = null;
  #manifestDigest: string | null = null;
  #lockedHostId: string | null = null;
  #lastSeenMs = 0;
  #hostExpiryTimer: NodeJS.Timeout | null = null;
  #registeredWithRegistry = false;
  #registering = false;
  #active: ActiveRun | null = null;
  #closed = false;

  constructor(options: LoopbackRelayCoordinatorOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#hostTtlMs = options.hostTtlMs ?? LOOPBACK_RELAY_DEFAULT_HOST_TTL_MS;
    this.#pollAfterMs = options.pollAfterMs ?? LOOPBACK_RELAY_DEFAULT_POLL_MS;
    this.#cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
    this.#terminalRecordLimit = options.terminalRecordLimit ?? DEFAULT_TERMINAL_RECORD_LIMIT;
    this.#onFirstHost = options.onFirstHost ?? null;

    if (!Number.isInteger(this.#hostTtlMs) || this.#hostTtlMs <= 0 || this.#hostTtlMs > 60_000) {
      throw new RangeError('hostTtlMs must be an integer between 1 and 60000');
    }
    if (!Number.isInteger(this.#pollAfterMs) || this.#pollAfterMs <= 0 || this.#pollAfterMs > 5_000) {
      throw new RangeError('pollAfterMs must be an integer between 1 and 5000');
    }
    if (!Number.isInteger(this.#cleanupGraceMs) || this.#cleanupGraceMs <= 0 || this.#cleanupGraceMs > 30_000) {
      throw new RangeError('cleanupGraceMs must be an integer between 1 and 30000');
    }
    if (
      !Number.isInteger(this.#terminalRecordLimit) ||
      this.#terminalRecordLimit <= 0 ||
      this.#terminalRecordLimit > MAX_TERMINAL_RECORD_LIMIT
    ) {
      throw new RangeError(`terminalRecordLimit must be an integer between 1 and ${MAX_TERMINAL_RECORD_LIMIT}`);
    }
  }

  async register(request: RelayRegisterRequest): Promise<RelayRegisterResponse> {
    this.#assertOpen();
    if (this.#registering) {
      throw new RelayError('request_busy', 'another host registration is already being processed');
    }
    this.#registering = true;

    const previous = {
      descriptor: this.#descriptor,
      manifestDigest: this.#manifestDigest,
      lockedHostId: this.#lockedHostId,
      lastSeenMs: this.#lastSeenMs
    };

    try {
      const parsed = RelayRegisterRequestSchema.parse(request);
      const descriptor = HostDescriptorSchema.parse(parsed.descriptor);
      this.#assertCompatibleDescriptor(descriptor);

      if (this.#lockedHostId !== null && descriptor.hostId !== this.#lockedHostId) {
        throw new RelayError(
          'host_collision',
          `loopback relay is locked to host ${this.#lockedHostId}, not ${descriptor.hostId}`
        );
      }

      const manifest = descriptorManifest(descriptor);
      if (this.#descriptor !== null) {
        if (descriptor.generation < this.#descriptor.generation) {
          throw new RelayError(
            'host_generation_stale',
            `host generation ${descriptor.generation} is stale; current generation is ${this.#descriptor.generation}`
          );
        }
        if (descriptor.generation === this.#descriptor.generation && manifest !== this.#manifestDigest) {
          throw new RelayError('host_manifest_changed', 'host manifest changed without advancing the host generation');
        }
        if (descriptor.generation > this.#descriptor.generation) {
          this.#failActiveForHostReplacement();
        }
      }

      this.#lockedHostId = descriptor.hostId;
      this.#descriptor = descriptor;
      this.#manifestDigest = manifest;
      this.#touchHost();

      if (!this.#registeredWithRegistry && this.#onFirstHost !== null) {
        await this.#onFirstHost(this);
        this.#registeredWithRegistry = true;
      }

      this.#notifyPollers();
      return RelayRegisterResponseSchema.parse({
        protocol: LOOPBACK_RELAY_PROTOCOL,
        accepted: true,
        hostId: descriptor.hostId,
        generation: descriptor.generation,
        heartbeatTtlMs: this.#hostTtlMs,
        pollAfterMs: this.#pollAfterMs
      });
    } catch (error) {
      if (!this.#registeredWithRegistry) {
        this.#descriptor = previous.descriptor;
        this.#manifestDigest = previous.manifestDigest;
        this.#lockedHostId = previous.lockedHostId;
        this.#lastSeenMs = previous.lastSeenMs;
        if (this.#hostExpiryTimer !== null) {
          clearTimeout(this.#hostExpiryTimer);
          this.#hostExpiryTimer = null;
        }
        if (this.#descriptor !== null) this.#scheduleHostExpiry();
      }
      throw error;
    } finally {
      this.#registering = false;
    }
  }

  async poll(request: RelayPollRequest): Promise<RelayCommand> {
    this.#assertOpen();
    const parsed = RelayPollRequestSchema.parse(request);
    this.#assertIdentity(parsed);
    this.#acknowledgeCommand(parsed.acknowledgedCommandId);
    this.#touchHost();

    const observedVersion = this.#activityVersion;
    let command = this.#nextCommand();
    if (command.kind !== 'idle' || parsed.waitMs === 0) return command;

    await this.#waitForWork(parsed.waitMs, observedVersion);
    this.#assertOpen();
    this.#assertIdentity(parsed);
    this.#touchHost();
    command = this.#nextCommand();
    return command;
  }

  async submitResult(request: RelayResultRequest): Promise<RelayAcceptedResponse> {
    this.#assertOpen();
    const parsed = RelayResultRequestSchema.parse(request);
    this.#assertIdentity(parsed);

    const result = ExecutionResultSchema.parse(parsed.result);
    const digest = resultDigest(result);
    const terminal = this.#terminals.get(result.requestId);
    if (terminal !== undefined) {
      if (terminal.resultDigest === digest) {
        this.#touchHost();
        return RelayAcceptedResponseSchema.parse({
          protocol: LOOPBACK_RELAY_PROTOCOL,
          accepted: true,
          duplicate: true
        });
      }
      throw new RelayError(
        'terminal_collision',
        `request ${result.requestId} already has an immutable terminal outcome`
      );
    }

    const active = this.#active;
    if (active === null || active.request.requestId !== result.requestId) {
      throw new RelayError('request_unknown', `request ${result.requestId} is not active on this relay`);
    }

    this.#assertResultBound(active, result);
    if (resultOutputBytes(result) > active.request.limits.outputBytes) {
      throw new RelayError(
        'invalid_request',
        `terminal output exceeds the request bound of ${active.request.limits.outputBytes} bytes`
      );
    }

    this.#assertCancellationResult(active, result);
    this.#touchHost();
    this.#recordTerminal(result.requestId, {
      requestDigest: requestDigest(active.request),
      resultDigest: digest,
      result,
      status: 'result'
    });
    this.#clearRunTimers(active);
    this.#active = null;
    if (!active.callerSettled) {
      active.callerSettled = true;
      active.resolve(result);
    }
    this.#notifyPollers();

    return RelayAcceptedResponseSchema.parse({
      protocol: LOOPBACK_RELAY_PROTOCOL,
      accepted: true,
      duplicate: false
    });
  }

  async describe(): Promise<HostDescriptor> {
    this.#assertOpenOrKnownHost();
    const descriptor = this.#descriptor;
    if (descriptor === null) {
      throw new GatewayError('host_unavailable', 'no loopback Hara execution host has enrolled');
    }

    const state = this.#currentHostState();
    if (state === 'offline') this.#failActiveForHostLoss();
    return HostDescriptorSchema.parse({
      ...descriptor,
      state,
      observedAt: new Date(this.#lastSeenMs).toISOString()
    });
  }

  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    this.#assertOpen();
    const parsed = ExecutionRequestSchema.parse(request);
    const digest = requestDigest(parsed);
    const terminal = this.#terminals.get(parsed.requestId);
    if (terminal !== undefined) {
      if (terminal.requestDigest !== digest) {
        throw new GatewayError(
          'request_invalid',
          `request ID ${parsed.requestId} is already bound to different content`
        );
      }
      if (terminal.result !== null) return terminal.result;
      switch (terminal.status) {
        case 'cancelled':
          throw new GatewayError('cancelled', `request ${parsed.requestId} was already cancelled`);
        case 'timed_out':
          throw new GatewayError('timed_out', `request ${parsed.requestId} already timed out`);
        case 'host_unavailable':
        case 'relay_closed':
          throw new GatewayError(
            'host_unavailable',
            `request ${parsed.requestId} has an immutable unavailable outcome`
          );
        case 'result':
          throw new GatewayError('host_result_invalid', `request ${parsed.requestId} has an invalid retained result`);
      }
    }

    const descriptor = await this.describe();

    if (descriptor.state !== 'ready') {
      throw new GatewayError('host_unavailable', `loopback host ${descriptor.hostId} is ${descriptor.state}`);
    }
    if (!descriptor.profiles.includes(PURE_PROFILE) || !descriptor.operations.includes(parsed.operation)) {
      throw new GatewayError(
        'host_incompatible',
        `loopback host ${descriptor.hostId} does not advertise ${PURE_PROFILE} with ${parsed.operation}`
      );
    }
    if (this.#active !== null) {
      throw new GatewayError('host_busy', `loopback host ${descriptor.hostId} already has an active request`);
    }
    if (signal?.aborted === true) {
      throw new GatewayError('cancelled', `request ${parsed.requestId} was cancelled before relay delivery`);
    }

    return await new Promise<ExecutionResult>((resolve, reject) => {
      const active: ActiveRun = {
        request: parsed,
        descriptor,
        executeCommandId: relayCommandId(parsed.requestId, 'execute'),
        executeIssued: false,
        executeAcknowledged: false,
        cancelCommandId: relayCommandId(parsed.requestId, 'cancel'),
        cancelIssued: false,
        cancelAcknowledged: false,
        cancelReason: null,
        callerSettled: false,
        resolve,
        reject,
        deadlineTimer: null,
        cleanupTimer: null,
        signal: signal ?? null,
        abortListener: null
      };

      active.deadlineTimer = setTimeout(() => {
        this.#beginCancellation(active, 'deadline-exceeded', 'timed_out');
      }, parsed.limits.wallMs);

      if (signal !== undefined) {
        const abortListener = (): void => {
          this.#beginCancellation(active, 'client-cancelled', 'cancelled');
        };
        active.abortListener = abortListener;
        signal.addEventListener('abort', abortListener, { once: true });
      }

      this.#active = active;
      this.#notifyPollers();
    });
  }

  async cancel(requestId: string): Promise<boolean> {
    this.#assertOpen();
    const active = this.#active;
    if (active !== null && active.request.requestId === requestId) {
      this.#beginCancellation(active, 'client-cancelled', 'cancelled');
      return true;
    }
    const terminal = this.#terminals.get(requestId);
    return terminal?.status === 'cancelled' || terminal?.result?.status === 'cancelled';
  }

  health(): RelayHealthResponse {
    const state = this.#descriptor === null ? 'unknown' : this.#currentHostState();
    if (state === 'offline') this.#failActiveForHostLoss();
    return RelayHealthResponseSchema.parse({
      protocol: LOOPBACK_RELAY_PROTOCOL,
      status: 'ok',
      hostState: state,
      activeRequest: this.#active !== null
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (active !== null) {
      this.#settleCallerError(active, 'host_unavailable', 'loopback relay closed before terminal execution');
      this.#recordTerminal(active.request.requestId, {
        requestDigest: requestDigest(active.request),
        resultDigest: null,
        result: null,
        status: 'relay_closed'
      });
      this.#clearRunTimers(active);
      this.#active = null;
    }
    if (this.#hostExpiryTimer !== null) {
      clearTimeout(this.#hostExpiryTimer);
      this.#hostExpiryTimer = null;
    }
    this.#notifyPollers();
  }

  #assertCompatibleDescriptor(descriptor: HostDescriptor): void {
    if (descriptor.state !== 'ready' && descriptor.state !== 'degraded') {
      throw new RelayError('host_incompatible', `host must register as ready or degraded, not ${descriptor.state}`);
    }
    if (!descriptor.profiles.includes(PURE_PROFILE)) {
      throw new RelayError('host_incompatible', `host does not advertise required profile ${PURE_PROFILE}`);
    }
    if (!descriptor.operations.includes('runtime.get')) {
      throw new RelayError('host_incompatible', 'host does not advertise runtime.get');
    }
  }

  #assertIdentity(identity: RelayHostIdentity): void {
    const parsed = RelayHostIdentitySchema.parse({
      protocol: identity.protocol,
      hostId: identity.hostId,
      generation: identity.generation
    });
    const descriptor = this.#descriptor;
    if (descriptor === null) {
      throw new RelayError('host_generation_stale', 'no host generation is enrolled');
    }
    if (parsed.hostId !== descriptor.hostId) {
      throw new RelayError('host_collision', `relay is enrolled to host ${descriptor.hostId}, not ${parsed.hostId}`);
    }
    if (parsed.generation !== descriptor.generation) {
      throw new RelayError(
        'host_generation_stale',
        `host generation ${parsed.generation} is stale; current generation is ${descriptor.generation}`
      );
    }
  }

  #assertResultBound(active: ActiveRun, result: ExecutionResult): void {
    const descriptor = active.descriptor;
    if (result.requestId !== active.request.requestId) {
      throw new RelayError('invalid_request', 'terminal result changed the active request ID');
    }
    if (result.runtime.hostId !== descriptor.hostId) {
      throw new RelayError('invalid_request', 'terminal result changed the selected host ID');
    }
    if (result.runtime.hostGeneration !== descriptor.generation) {
      throw new RelayError('host_generation_stale', 'terminal result changed the selected host generation');
    }
    if (result.runtime.backend !== descriptor.backend) {
      throw new RelayError('invalid_request', 'terminal result changed the selected runtime backend');
    }
    if (result.runtime.runtimeBuild !== descriptor.runtimeBuild) {
      throw new RelayError('invalid_request', 'terminal result changed the selected runtime build');
    }
    if (result.runtime.haraVersion !== descriptor.haraVersion) {
      throw new RelayError('invalid_request', 'terminal result changed the selected Hara version');
    }
    if (result.evidence.profile !== active.request.profile) {
      throw new RelayError('invalid_request', 'terminal result changed the sandbox profile');
    }
    if (result.evidence.sourceDigest !== active.request.sourceDigest) {
      throw new RelayError('invalid_request', 'terminal result changed the source digest');
    }
  }

  #assertCancellationResult(active: ActiveRun, result: ExecutionResult): void {
    switch (active.cancelReason) {
      case null:
        return;
      case 'client-cancelled':
      case 'relay-closing':
        if (result.status !== 'cancelled') {
          throw new RelayError(
            'invalid_request',
            `request ${result.requestId} was cancelled and cannot settle as ${result.status}`
          );
        }
        return;
      case 'deadline-exceeded':
        if (result.status !== 'timed-out') {
          throw new RelayError(
            'invalid_request',
            `request ${result.requestId} exceeded its deadline and cannot settle as ${result.status}`
          );
        }
    }
  }

  #acknowledgeCommand(commandId: string | undefined): void {
    if (commandId === undefined) return;
    const active = this.#active;
    if (active === null) {
      throw new RelayError('request_unknown', `command ${commandId} has no active relay request`);
    }
    if (commandId === active.executeCommandId) {
      if (!active.executeIssued) {
        throw new RelayError('invalid_request', `execute command ${commandId} was not issued`);
      }
      active.executeAcknowledged = true;
      return;
    }
    if (commandId === active.cancelCommandId) {
      if (!active.cancelIssued) {
        throw new RelayError('invalid_request', `cancel command ${commandId} was not issued`);
      }
      active.cancelAcknowledged = true;
      return;
    }
    throw new RelayError('invalid_request', `command ${commandId} does not belong to the active request`);
  }

  #nextCommand(): RelayCommand {
    const active = this.#active;
    if (active !== null) {
      if (active.cancelReason !== null && !active.cancelAcknowledged) {
        active.cancelIssued = true;
        return RelayCommandSchema.parse({
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: 'cancel',
          commandId: active.cancelCommandId,
          requestId: active.request.requestId,
          reason: active.cancelReason
        });
      }
      if (active.cancelReason === null && !active.executeAcknowledged) {
        active.executeIssued = true;
        return RelayCommandSchema.parse({
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: 'execute',
          commandId: active.executeCommandId,
          request: active.request
        });
      }
    }

    return RelayCommandSchema.parse({
      protocol: LOOPBACK_RELAY_PROTOCOL,
      kind: 'idle',
      retryAfterMs: this.#pollAfterMs
    });
  }

  #beginCancellation(active: ActiveRun, reason: CancelReason, errorCode: 'cancelled' | 'timed_out'): void {
    if (this.#active !== active) return;
    if (active.cancelReason === null) active.cancelReason = reason;

    const message =
      errorCode === 'timed_out'
        ? `request ${active.request.requestId} exceeded ${active.request.limits.wallMs}ms`
        : `request ${active.request.requestId} was cancelled`;
    this.#settleCallerError(active, errorCode, message);

    if (!active.executeIssued) {
      this.#recordTerminal(active.request.requestId, {
        requestDigest: requestDigest(active.request),
        resultDigest: null,
        result: null,
        status: errorCode
      });
      this.#clearRunTimers(active);
      this.#active = null;
      this.#notifyPollers();
      return;
    }

    if (active.deadlineTimer !== null) {
      clearTimeout(active.deadlineTimer);
      active.deadlineTimer = null;
    }
    if (active.cleanupTimer === null) {
      active.cleanupTimer = setTimeout(() => {
        if (this.#active !== active) return;
        this.#recordTerminal(active.request.requestId, {
          requestDigest: requestDigest(active.request),
          resultDigest: null,
          result: null,
          status: errorCode
        });
        this.#clearRunTimers(active);
        this.#active = null;
        this.#notifyPollers();
      }, this.#cleanupGraceMs);
    }
    this.#notifyPollers();
  }

  #settleCallerError(active: ActiveRun, code: 'cancelled' | 'timed_out' | 'host_unavailable', message: string): void {
    if (active.callerSettled) return;
    active.callerSettled = true;
    active.reject(new GatewayError(code, message));
  }

  #terminalStatusForInterruptedRun(active: ActiveRun): LocalTerminalStatus {
    if (active.cancelReason === 'client-cancelled' || active.cancelReason === 'relay-closing') return 'cancelled';
    if (active.cancelReason === 'deadline-exceeded') return 'timed_out';
    return 'host_unavailable';
  }

  #failActiveForHostReplacement(): void {
    const active = this.#active;
    if (active === null) return;
    this.#settleCallerError(active, 'host_unavailable', 'host generation changed before terminal execution');
    this.#recordTerminal(active.request.requestId, {
      requestDigest: requestDigest(active.request),
      resultDigest: null,
      result: null,
      status: this.#terminalStatusForInterruptedRun(active)
    });
    this.#clearRunTimers(active);
    this.#active = null;
  }

  #failActiveForHostLoss(): void {
    const active = this.#active;
    if (active === null) return;
    this.#settleCallerError(active, 'host_unavailable', 'loopback host heartbeat expired before terminal execution');
    this.#recordTerminal(active.request.requestId, {
      requestDigest: requestDigest(active.request),
      resultDigest: null,
      result: null,
      status: this.#terminalStatusForInterruptedRun(active)
    });
    this.#clearRunTimers(active);
    this.#active = null;
    this.#notifyPollers();
  }

  #clearRunTimers(active: ActiveRun): void {
    if (active.deadlineTimer !== null) clearTimeout(active.deadlineTimer);
    if (active.cleanupTimer !== null) clearTimeout(active.cleanupTimer);
    if (active.signal !== null && active.abortListener !== null) {
      active.signal.removeEventListener('abort', active.abortListener);
    }
    active.deadlineTimer = null;
    active.cleanupTimer = null;
    active.abortListener = null;
  }

  #recordTerminal(requestId: string, record: TerminalRecord): void {
    const previous = this.#terminals.get(requestId);
    if (previous !== undefined) {
      if (
        previous.requestDigest === record.requestDigest &&
        previous.resultDigest === record.resultDigest &&
        previous.status === record.status
      ) {
        return;
      }
      throw new Error(`attempted to mutate terminal relay record ${requestId}`);
    }
    this.#terminals.set(requestId, record);
    while (this.#terminals.size > this.#terminalRecordLimit) {
      const oldest = this.#terminals.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminals.delete(oldest);
    }
  }

  #touchHost(): void {
    this.#lastSeenMs = this.#now().getTime();
    this.#scheduleHostExpiry();
  }

  #scheduleHostExpiry(): void {
    if (this.#hostExpiryTimer !== null) clearTimeout(this.#hostExpiryTimer);
    if (this.#closed || this.#descriptor === null) {
      this.#hostExpiryTimer = null;
      return;
    }
    const observedAt = this.#lastSeenMs;
    this.#hostExpiryTimer = setTimeout(() => {
      this.#hostExpiryTimer = null;
      if (this.#closed || this.#descriptor === null || this.#lastSeenMs !== observedAt) return;
      if (this.#currentHostState() === 'offline') {
        this.#failActiveForHostLoss();
        this.#notifyPollers();
        return;
      }
      this.#scheduleHostExpiry();
    }, this.#hostTtlMs + 1);
    this.#hostExpiryTimer.unref();
  }

  #currentHostState(): HostDescriptor['state'] {
    const descriptor = this.#descriptor;
    if (descriptor === null || this.#closed) return 'offline';
    if (this.#now().getTime() - this.#lastSeenMs > this.#hostTtlMs) return 'offline';
    return descriptor.state;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RelayError('relay_closed', 'loopback relay is closed');
  }

  #assertOpenOrKnownHost(): void {
    if (this.#closed && this.#descriptor === null) {
      throw new GatewayError('host_unavailable', 'loopback relay is closed');
    }
  }

  #notifyPollers(): void {
    this.#activityVersion += 1;
    for (const wake of this.#pollWaiters) wake();
    this.#pollWaiters.clear();
  }

  async #waitForWork(waitMs: number, observedVersion: number): Promise<void> {
    if (waitMs <= 0 || observedVersion !== this.#activityVersion) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pollWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      this.#pollWaiters.add(finish);
      if (observedVersion !== this.#activityVersion) finish();
    });
  }
}

export class LoopbackRelayServer {
  readonly #coordinator: LoopbackRelayCoordinator;
  readonly #pairingToken: string;
  readonly #bindAddress: string;
  readonly #port: number;
  readonly #allowedOrigin: string | null;
  readonly #maxBodyBytes: number;

  #server: Server | null = null;
  #address: LoopbackRelayAddress | null = null;
  #closed = false;

  constructor(coordinator: LoopbackRelayCoordinator, options: LoopbackRelayServerOptions) {
    this.#coordinator = coordinator;
    this.#pairingToken = options.pairingToken;
    this.#bindAddress = options.bindAddress ?? LOOPBACK_RELAY_BIND_ADDRESS;
    this.#port = options.port ?? LOOPBACK_RELAY_DEFAULT_PORT;
    this.#allowedOrigin = options.allowedOrigin ?? null;
    this.#maxBodyBytes = options.maxBodyBytes ?? LOOPBACK_RELAY_MAX_BODY_BYTES;

    if (this.#bindAddress !== LOOPBACK_RELAY_BIND_ADDRESS) {
      throw new RelayError(
        'invalid_request',
        `loopback relay must bind exactly to ${LOOPBACK_RELAY_BIND_ADDRESS}, not ${this.#bindAddress}`
      );
    }
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65_535) {
      throw new RangeError('relay port must be an integer between 0 and 65535');
    }
    if (Buffer.byteLength(this.#pairingToken, 'utf8') < 16 || /\s/u.test(this.#pairingToken)) {
      throw new RelayError(
        'invalid_request',
        'development pairing token must contain at least 16 non-whitespace bytes'
      );
    }
    if (!Number.isInteger(this.#maxBodyBytes) || this.#maxBodyBytes < 1_024 || this.#maxBodyBytes > 16_777_216) {
      throw new RangeError('maxBodyBytes must be an integer between 1024 and 16777216');
    }
    if (this.#allowedOrigin?.includes('*') === true || /[\r\n]/u.test(this.#allowedOrigin ?? '')) {
      throw new RelayError('origin_forbidden', 'wildcard or multiline relay origins are prohibited');
    }
  }

  get address(): LoopbackRelayAddress | null {
    return this.#address;
  }

  async start(): Promise<LoopbackRelayAddress> {
    if (this.#closed) throw new RelayError('relay_closed', 'loopback relay server is closed');
    if (this.#server !== null) {
      if (this.#address === null) throw new Error('relay server is starting without an address');
      return this.#address;
    }

    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.headersTimeout = LOOPBACK_RELAY_HEADERS_TIMEOUT_MS;
    server.requestTimeout = LOOPBACK_RELAY_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 32;
    server.maxRequestsPerSocket = 256;
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: LOOPBACK_RELAY_BIND_ADDRESS, port: this.#port, exclusive: true });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      await this.close();
      throw new Error('loopback relay did not receive a TCP address');
    }
    const port = (address as AddressInfo).port;
    this.#address = {
      host: LOOPBACK_RELAY_BIND_ADDRESS,
      port,
      url: `http://${LOOPBACK_RELAY_BIND_ADDRESS}:${port}`
    };
    return this.#address;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const server = this.#server;
    this.#server = null;
    this.#address = null;
    await Promise.allSettled([
      this.#coordinator.close(),
      server === null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections();
          })
    ]);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      const path = request.url?.split('?', 1)[0] ?? '/';
      if (path === '/v0/health') {
        if (request.method !== 'GET') throw new RelayError('method_not_allowed', 'health endpoint requires GET');
        this.#respond(response, 200, this.#coordinator.health());
        return;
      }

      if (!LOOPBACK_RELAY_HOST_PATHS.has(path)) throw new RelayError('not_found', 'relay endpoint not found');
      if (request.method === 'OPTIONS') {
        this.#assertOrigin(request, response);
        response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
        response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method !== 'POST') throw new RelayError('method_not_allowed', 'host endpoint requires POST');

      this.#assertOrigin(request, response);
      if (!secureTokenEqual(this.#pairingToken, request.headers.authorization)) {
        throw new RelayError('authentication_failed', 'invalid loopback host authorization');
      }
      const body = await this.#readJson(request);

      switch (path) {
        case '/v0/host/register': {
          const parsed = RelayRegisterRequestSchema.parse(body);
          this.#respond(response, 201, await this.#coordinator.register(parsed));
          return;
        }
        case '/v0/host/poll': {
          const parsed = RelayPollRequestSchema.parse(body);
          this.#respond(response, 200, await this.#coordinator.poll(parsed));
          return;
        }
        case '/v0/host/result': {
          const parsed = RelayResultRequestSchema.parse(body);
          this.#respond(response, 200, await this.#coordinator.submitResult(parsed));
          return;
        }
        default:
          throw new RelayError('not_found', 'relay endpoint not found');
      }
    } catch (error) {
      const relayError = this.#normalizeError(error);
      this.#respond(
        response,
        this.#statusFor(relayError.code),
        RelayErrorResponseSchema.parse({
          protocol: LOOPBACK_RELAY_PROTOCOL,
          accepted: false,
          error: { code: relayError.code, message: relayError.message }
        })
      );
    }
  }

  #assertOrigin(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (this.#allowedOrigin === null || origin !== this.#allowedOrigin) {
      throw new RelayError('origin_forbidden', 'request origin is not allowed by the loopback relay');
    }
    response.setHeader('Access-Control-Allow-Origin', this.#allowedOrigin);
    response.setHeader('Vary', 'Origin');
  }

  async #readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers['content-type'];
    if (contentType === undefined || !contentType.toLowerCase().startsWith('application/json')) {
      throw new RelayError('invalid_request', 'relay host endpoints require application/json');
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.byteLength;
      if (total > this.#maxBodyBytes) {
        tooLarge = true;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    }
    if (tooLarge) {
      throw new RelayError('body_too_large', `relay request exceeds ${this.#maxBodyBytes} bytes`);
    }
    if (total === 0) throw new RelayError('invalid_request', 'relay request body is empty');

    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new RelayError('invalid_request', 'relay request body is not valid JSON');
    }
  }

  #normalizeError(error: unknown): RelayError {
    if (error instanceof RelayError) return error;
    if (error instanceof GatewayError) {
      const code: RelayErrorCode =
        error.code === 'host_collision'
          ? 'host_collision'
          : error.code === 'host_incompatible'
            ? 'host_incompatible'
            : error.code === 'host_busy'
              ? 'request_busy'
              : 'invalid_request';
      return new RelayError(code, error.message);
    }
    if (error instanceof Error && 'issues' in error) {
      return new RelayError('invalid_request', firstValidationMessage(error));
    }
    return new RelayError('internal_error', error instanceof Error ? error.message : String(error));
  }

  #statusFor(code: RelayErrorCode): number {
    switch (code) {
      case 'authentication_failed':
        return 401;
      case 'origin_forbidden':
        return 403;
      case 'body_too_large':
        return 413;
      case 'method_not_allowed':
        return 405;
      case 'not_found':
        return 404;
      case 'host_collision':
      case 'host_generation_stale':
      case 'host_manifest_changed':
      case 'request_busy':
      case 'request_terminal':
      case 'terminal_collision':
        return 409;
      case 'relay_closed':
        return 503;
      case 'host_incompatible':
      case 'invalid_request':
        return 400;
      case 'request_unknown':
        return 404;
      case 'internal_error':
        return 500;
    }
  }

  #respond(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return;
    response.statusCode = status;
    response.end(JSON.stringify(body));
  }
}
