import * as z from 'zod/v4';

import {
  HOST_SOCKET_CLOSE_CODES,
  HOST_SOCKET_PATH,
  HOST_SOCKET_PRODUCTION_URL,
  HOST_SOCKET_PROTOCOL,
  HOST_SOCKET_SUBPROTOCOL,
  HostSocketCancelFrameSchema,
  HostSocketOfferFrameSchema,
  RelayToHostFrameSchema,
  parseHostToRelayFrame,
  parseRelayToHostFrame,
  type HostToRelayFrame,
  type RelayToHostFrame
} from './host-socket-protocol.js';
import {
  DigestSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  HostDescriptorSchema,
  IdentifierSchema,
  RequestIdSchema,
  type ExecutionRequest,
  type ExecutionResult,
  type HostDescriptor
} from './protocol.js';

export const HOSTED_RELAY_DEPLOYMENT_PROTOCOL = 'hara.host-relay-deployment/0-alpha' as const;
export const HOSTED_RELAY_HTTPS_ROUTE_URL = 'https://mcp.hara-lang.org/relay/host/v1' as const;
export const HOSTED_RELAY_STORAGE = 'durable-object-sqlite' as const;
export const HOSTED_RELAY_DEFAULT_HEARTBEAT_TTL_MS = 30_000;
export const HOSTED_RELAY_DEFAULT_TERMINAL_LIMIT = 64;
export const HOSTED_RELAY_DEFAULT_MESSAGE_LIMIT = 64;

export const HostedRelayDeploymentSchema = z
  .object({
    protocol: z.literal(HOSTED_RELAY_DEPLOYMENT_PROTOCOL),
    enabled: z.boolean(),
    socketUrl: z.literal(HOST_SOCKET_PRODUCTION_URL),
    routeUrl: z.literal(HOSTED_RELAY_HTTPS_ROUTE_URL),
    path: z.literal(HOST_SOCKET_PATH),
    subprotocol: z.literal(HOST_SOCKET_SUBPROTOCOL),
    objectKey: z.literal('host-id'),
    storage: z.literal(HOSTED_RELAY_STORAGE),
    hibernation: z.literal(true)
  })
  .strict();
export type HostedRelayDeployment = z.infer<typeof HostedRelayDeploymentSchema>;

export const HOSTED_RELAY_DISABLED_DEPLOYMENT = Object.freeze(
  HostedRelayDeploymentSchema.parse({
    protocol: HOSTED_RELAY_DEPLOYMENT_PROTOCOL,
    enabled: false,
    socketUrl: HOST_SOCKET_PRODUCTION_URL,
    routeUrl: HOSTED_RELAY_HTTPS_ROUTE_URL,
    path: HOST_SOCKET_PATH,
    subprotocol: HOST_SOCKET_SUBPROTOCOL,
    objectKey: 'host-id',
    storage: HOSTED_RELAY_STORAGE,
    hibernation: true
  })
);

export const HostedRelayPrincipalSchema = z
  .object({
    hostId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    manifestDigest: DigestSchema,
    audience: z.literal(HOST_SOCKET_PRODUCTION_URL),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict();
export type HostedRelayPrincipal = z.infer<typeof HostedRelayPrincipalSchema>;

export interface HostedRelayUpgradeRequest {
  method: string;
  url: string;
  upgrade: string | null;
  subprotocol: string | null;
}

export interface HostedRelayRouteDecision {
  accepted: true;
  objectName: string;
  responseSubprotocol: typeof HOST_SOCKET_SUBPROTOCOL;
  principal: HostedRelayPrincipal;
}

export type HostedRelayErrorCode =
  | 'host_relay_config_invalid'
  | 'host_relay_disabled'
  | 'host_socket_route_invalid'
  | 'host_socket_upgrade_required'
  | 'host_socket_subprotocol_invalid'
  | 'host_authentication_required'
  | 'host_authorization_invalid'
  | 'host_authorization_expired'
  | 'host_identity_stale'
  | 'host_manifest_changed'
  | 'host_connection_unavailable'
  | 'host_connection_replaced'
  | 'host_resync_required'
  | 'host_request_busy'
  | 'host_request_unknown'
  | 'host_request_terminal'
  | 'host_command_invalid'
  | 'host_message_collision'
  | 'host_terminal_collision'
  | 'host_result_invalid'
  | 'host_relay_storage_invalid';

export class HostedRelayError extends Error {
  readonly code: HostedRelayErrorCode;
  readonly status: number;
  readonly closeCode: number;

  constructor(
    code: HostedRelayErrorCode,
    message: string,
    status: number = 400,
    closeCode: number = HOST_SOCKET_CLOSE_CODES.policyViolation
  ) {
    super(message);
    this.name = 'HostedRelayError';
    this.code = code;
    this.status = status;
    this.closeCode = closeCode;
  }
}

function relayError(
  code: HostedRelayErrorCode,
  message: string,
  status: number = 400,
  closeCode: number = HOST_SOCKET_CLOSE_CODES.policyViolation
): never {
  throw new HostedRelayError(code, message, status, closeCode);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function dateValue(value: Date, label: string): Date {
  if (!Number.isFinite(value.valueOf())) relayError('host_authorization_invalid', `${label} returned an invalid date`);
  return value;
}

function firstValidationMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'invalid hosted relay value';
  const issues = (error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues;
  const issue = issues?.[0];
  if (issue === undefined) return error.message;
  const path = issue.path?.map(String).join('.') ?? '';
  return path.length === 0 ? (issue.message ?? error.message) : `${path}: ${issue.message ?? error.message}`;
}

function parseDeployment(value: unknown): HostedRelayDeployment {
  try {
    return HostedRelayDeploymentSchema.parse(value);
  } catch (error) {
    return relayError('host_relay_config_invalid', firstValidationMessage(error), 500);
  }
}

function parsePrincipal(value: unknown): HostedRelayPrincipal {
  try {
    return HostedRelayPrincipalSchema.parse(value);
  } catch (error) {
    return relayError(
      'host_authorization_invalid',
      firstValidationMessage(error),
      401,
      HOST_SOCKET_CLOSE_CODES.authenticationFailed
    );
  }
}

export function routeHostedRelayUpgrade(
  request: HostedRelayUpgradeRequest,
  principalValue: unknown,
  deploymentValue: unknown = HOSTED_RELAY_DISABLED_DEPLOYMENT,
  now: () => Date = () => new Date()
): HostedRelayRouteDecision {
  const deployment = parseDeployment(deploymentValue);
  if (!deployment.enabled) {
    return relayError(
      'host_relay_disabled',
      'host relay production traffic is disabled',
      503,
      HOST_SOCKET_CLOSE_CODES.tryAgainLater
    );
  }
  if (request.method !== 'GET' || request.url !== deployment.routeUrl) {
    return relayError(
      'host_socket_route_invalid',
      'host socket request does not match the exact production route',
      404
    );
  }
  if (request.upgrade?.toLowerCase() !== 'websocket') {
    return relayError('host_socket_upgrade_required', 'host socket route requires a WebSocket upgrade', 426);
  }
  if (request.subprotocol !== deployment.subprotocol) {
    return relayError(
      'host_socket_subprotocol_invalid',
      `host socket subprotocol must be exactly ${deployment.subprotocol}`,
      400
    );
  }
  if (principalValue === null || principalValue === undefined) {
    return relayError(
      'host_authentication_required',
      'an enrolled host principal is required',
      401,
      HOST_SOCKET_CLOSE_CODES.authenticationFailed
    );
  }
  const principal = parsePrincipal(principalValue);
  const observed = dateValue(now(), 'host relay clock');
  if (Date.parse(principal.expiresAt) <= observed.valueOf()) {
    return relayError(
      'host_authorization_expired',
      'the enrolled host principal has expired',
      401,
      HOST_SOCKET_CLOSE_CODES.authenticationFailed
    );
  }
  return Object.freeze({
    accepted: true,
    objectName: principal.hostId,
    responseSubprotocol: HOST_SOCKET_SUBPROTOCOL,
    principal: cloneJson(principal)
  });
}

type HelloFrame = Extract<HostToRelayFrame, { kind: 'hello' }>;
type AckFrame = Extract<HostToRelayFrame, { kind: 'ack' }>;
type ResultFrame = Extract<HostToRelayFrame, { kind: 'result' }>;
type HeartbeatFrame = Extract<HostToRelayFrame, { kind: 'heartbeat' }>;
type OfferFrame = Extract<RelayToHostFrame, { kind: 'offer' }>;
type CancelFrame = Extract<RelayToHostFrame, { kind: 'cancel' }>;
type AcceptedFrame = Extract<RelayToHostFrame, { kind: 'accepted' }>;
type ReadyFrame = Extract<RelayToHostFrame, { kind: 'ready' }>;
type ResyncFrame = Extract<RelayToHostFrame, { kind: 'resync-required' }>;

const StoredCancelSchema = z
  .object({
    commandId: IdentifierSchema,
    reason: z.enum(['client-cancelled', 'deadline-exceeded', 'relay-closing']),
    frame: HostSocketCancelFrameSchema,
    acknowledged: z.boolean()
  })
  .strict();

const StoredActiveSchema = z
  .object({
    commandId: IdentifierSchema,
    request: ExecutionRequestSchema,
    requestFingerprint: z.string().min(1),
    offer: HostSocketOfferFrameSchema,
    acknowledged: z.boolean(),
    cancel: StoredCancelSchema.nullable()
  })
  .strict();

const StoredTerminalSchema = z
  .object({
    requestId: RequestIdSchema,
    requestFingerprint: z.string().min(1),
    resultFingerprint: z.string().min(1),
    result: ExecutionResultSchema
  })
  .strict();

const StoredHostMessageSchema = z
  .object({
    messageId: RequestIdSchema,
    frameFingerprint: z.string().min(1),
    response: RelayToHostFrameSchema
  })
  .strict();

export const HostedRelayDurableStateSchema = z
  .object({
    protocol: z.literal(HOSTED_RELAY_DEPLOYMENT_PROTOCOL),
    revision: z.number().int().nonnegative(),
    hostId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    manifestDigest: DigestSchema,
    descriptor: HostDescriptorSchema,
    connectionEpoch: RequestIdSchema.nullable(),
    connected: z.boolean(),
    lastRelaySequence: z.number().int().min(-1),
    lastRelayFrame: RelayToHostFrameSchema.nullable(),
    active: StoredActiveSchema.nullable(),
    terminals: z.array(StoredTerminalSchema).max(128),
    hostMessages: z.array(StoredHostMessageSchema).max(128),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();
export type HostedRelayDurableState = z.infer<typeof HostedRelayDurableStateSchema>;

export interface HostedRelayStateStore {
  load(): Promise<unknown | null>;
  save(state: HostedRelayDurableState): Promise<void>;
}

export interface HostedHostSocketRelayOptions {
  now?: () => Date;
  messageId?: () => string;
  heartbeatTtlMs?: number;
  terminalRecordLimit?: number;
  hostMessageLimit?: number;
}

export interface HostedRelaySnapshot {
  protocol: typeof HOSTED_RELAY_DEPLOYMENT_PROTOCOL;
  hostId: string | null;
  generation: number | null;
  connected: boolean;
  connectionEpoch: string | null;
  lastRelaySequence: number;
  activeRequestId: string | null;
  executeAcknowledged: boolean;
  cancelPending: boolean;
  cancelAcknowledged: boolean;
  terminalCount: number;
  revision: number;
}

function checkedLimit(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function outputBytes(result: ExecutionResult): number {
  return new TextEncoder().encode(
    JSON.stringify({
      value: result.value,
      stdout: result.stdout,
      stderr: result.stderr,
      diagnostics: result.diagnostics
    })
  ).byteLength;
}

function commandId(requestId: string, kind: 'execute' | 'cancel'): string {
  return `relay:${requestId}:${kind}`;
}

export class HostedHostSocketRelay {
  readonly #store: HostedRelayStateStore;
  readonly #now: () => Date;
  readonly #messageId: () => string;
  readonly #heartbeatTtlMs: number;
  readonly #terminalRecordLimit: number;
  readonly #hostMessageLimit: number;

  #cache: HostedRelayDurableState | null | undefined;
  #operation: Promise<void> = Promise.resolve();

  constructor(store: HostedRelayStateStore, options: HostedHostSocketRelayOptions = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('HostedHostSocketRelay requires a durable state store');
    }
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#messageId = options.messageId ?? (() => globalThis.crypto.randomUUID());
    this.#heartbeatTtlMs = checkedLimit(
      options.heartbeatTtlMs ?? HOSTED_RELAY_DEFAULT_HEARTBEAT_TTL_MS,
      'heartbeatTtlMs',
      60_000
    );
    this.#terminalRecordLimit = checkedLimit(
      options.terminalRecordLimit ?? HOSTED_RELAY_DEFAULT_TERMINAL_LIMIT,
      'terminalRecordLimit',
      128
    );
    this.#hostMessageLimit = checkedLimit(
      options.hostMessageLimit ?? HOSTED_RELAY_DEFAULT_MESSAGE_LIMIT,
      'hostMessageLimit',
      128
    );
  }

  acceptHello(value: unknown, principalValue: unknown): Promise<ReadyFrame | ResyncFrame> {
    return this.#serial(async () => {
      const parsed = parseHostToRelayFrame(value);
      if (parsed.kind !== 'hello') {
        return relayError('host_command_invalid', `expected hello frame, received ${parsed.kind}`);
      }
      const principal = this.#assertPrincipal(principalValue, parsed);
      let state = await this.#load();

      if (state !== null) {
        this.#assertStoredHost(state, parsed);
        const duplicate = this.#duplicateHostMessage(state, parsed);
        if (duplicate !== null) return duplicate as ReadyFrame | ResyncFrame;
      }

      if (state === null || parsed.generation > state.generation) {
        state = this.#initialState(parsed, state?.terminals ?? []);
      }

      if (state.generation !== principal.generation || state.manifestDigest !== principal.manifestDigest) {
        return relayError('host_identity_stale', 'stored host identity does not match the enrolled principal', 409);
      }

      const connectionChanged = state.connectionEpoch !== null && state.connectionEpoch !== parsed.connectionEpoch;
      if (connectionChanged && state.active?.acknowledged === true) {
        return this.#persistHelloResponse(state, parsed, this.#resyncFrame(state, parsed, 'connection-replaced'));
      }
      if (parsed.resumeAfter !== state.lastRelaySequence) {
        return this.#persistHelloResponse(state, parsed, this.#resyncFrame(state, parsed, 'cursor-stale'));
      }

      const ready = this.#relayFrame(state, parsed.connectionEpoch, {
        kind: 'ready',
        inReplyTo: parsed.messageId,
        heartbeatTtlMs: this.#heartbeatTtlMs,
        resumeAccepted: state.connectionEpoch !== null
      }) as ReadyFrame;
      const next = this.#rememberHostMessage(
        this.#advanceState(state, ready, {
          descriptor: cloneJson(parsed.descriptor),
          connectionEpoch: parsed.connectionEpoch,
          connected: true
        }),
        parsed,
        ready
      );
      await this.#persist(next);
      return ready;
    });
  }

  handleHostFrame(value: unknown): Promise<AcceptedFrame | RelayToHostFrame> {
    return this.#serial(async () => {
      const frame = parseHostToRelayFrame(value);
      if (frame.kind === 'hello') {
        return relayError('host_command_invalid', 'hello must be processed with acceptHello');
      }
      const state = await this.#requireConnectedState(frame);
      const duplicate = this.#duplicateHostMessage(state, frame);
      if (duplicate !== null) return duplicate;

      switch (frame.kind) {
        case 'ack':
          return this.#handleAck(state, frame);
        case 'result':
          return this.#handleResult(state, frame);
        case 'heartbeat':
          return this.#handleHeartbeat(state, frame);
      }
    });
  }

  issueOffer(requestValue: unknown): Promise<OfferFrame> {
    return this.#serial(async () => {
      const request = ExecutionRequestSchema.parse(requestValue);
      const state = await this.#requireLiveState();
      this.#assertRequestCompatible(state.descriptor, request);
      const requestFingerprint = fingerprint(request);
      const terminal = state.terminals.find((entry) => entry.requestId === request.requestId);
      if (terminal !== undefined) {
        if (terminal.requestFingerprint !== requestFingerprint) {
          return relayError(
            'host_terminal_collision',
            `request ID ${request.requestId} is bound to different content`,
            409
          );
        }
        return relayError('host_request_terminal', `request ${request.requestId} already has a terminal result`, 409);
      }
      if (state.active !== null) {
        if (state.active.requestFingerprint !== requestFingerprint) {
          return relayError('host_request_busy', `host ${state.hostId} already has an active request`, 409);
        }
        if (state.active.acknowledged) {
          return relayError(
            'host_resync_required',
            `request ${request.requestId} was accepted and cannot be reissued`,
            409,
            HOST_SOCKET_CLOSE_CODES.resyncRequired
          );
        }
        return this.#redeliverExecute(state);
      }

      const offer = this.#relayFrame(state, state.connectionEpoch, {
        kind: 'offer',
        commandId: commandId(request.requestId, 'execute'),
        request: cloneJson(request)
      }) as OfferFrame;
      const next = this.#advanceState(state, offer, {
        active: {
          commandId: offer.commandId,
          request: cloneJson(request),
          requestFingerprint,
          offer,
          acknowledged: false,
          cancel: null
        }
      });
      await this.#persist(next);
      return offer;
    });
  }

  issueCancel(
    requestIdValue: string,
    reason: 'client-cancelled' | 'deadline-exceeded' | 'relay-closing'
  ): Promise<CancelFrame> {
    return this.#serial(async () => {
      const requestId = RequestIdSchema.parse(requestIdValue);
      const state = await this.#requireLiveState();
      const active = state.active;
      if (active === null || active.request.requestId !== requestId) {
        return relayError('host_request_unknown', `request ${requestId} is not active`, 404);
      }
      if (active.cancel !== null) {
        if (active.cancel.reason !== reason) {
          return relayError(
            'host_command_invalid',
            `request ${requestId} already has a different cancellation reason`,
            409
          );
        }
        if (active.cancel.acknowledged) {
          return relayError('host_request_terminal', `cancellation for ${requestId} was already acknowledged`, 409);
        }
        return this.#redeliverCancel(state);
      }

      const cancel = this.#relayFrame(state, state.connectionEpoch, {
        kind: 'cancel',
        commandId: commandId(requestId, 'cancel'),
        requestId,
        reason
      }) as CancelFrame;
      const next = this.#advanceState(state, cancel, {
        active: {
          ...active,
          cancel: {
            commandId: cancel.commandId,
            reason,
            frame: cancel,
            acknowledged: false
          }
        }
      });
      await this.#persist(next);
      return cancel;
    });
  }

  redeliverPending(): Promise<OfferFrame | CancelFrame> {
    return this.#serial(async () => {
      const state = await this.#requireLiveState();
      const active = state.active;
      if (active === null) return relayError('host_request_unknown', 'there is no pending host command', 404);
      if (active.cancel !== null && !active.cancel.acknowledged) return this.#redeliverCancel(state);
      if (!active.acknowledged) return this.#redeliverExecute(state);
      return relayError(
        'host_resync_required',
        `request ${active.request.requestId} was already accepted and cannot be replayed`,
        409,
        HOST_SOCKET_CLOSE_CODES.resyncRequired
      );
    });
  }

  markDisconnected(connectionEpochValue: string): Promise<HostedRelaySnapshot> {
    return this.#serial(async () => {
      const connectionEpoch = RequestIdSchema.parse(connectionEpochValue);
      const state = await this.#load();
      if (state === null) return this.#snapshot(null);
      if (state.connectionEpoch !== connectionEpoch) return this.#snapshot(state);
      const next = this.#nextRevision(state, { connected: false });
      await this.#persist(next);
      return this.#snapshot(next);
    });
  }

  retainedResult(requestIdValue: string): Promise<ExecutionResult | null> {
    return this.#serial(async () => {
      const requestId = RequestIdSchema.parse(requestIdValue);
      const state = await this.#load();
      const terminal = state?.terminals.find((entry) => entry.requestId === requestId);
      return terminal === undefined ? null : cloneJson(terminal.result);
    });
  }

  snapshot(): Promise<HostedRelaySnapshot> {
    return this.#serial(async () => this.#snapshot(await this.#load()));
  }

  async #handleAck(state: HostedRelayDurableState, frame: AckFrame): Promise<AcceptedFrame> {
    const active = state.active;
    if (active === null) return relayError('host_request_unknown', `command ${frame.commandId} is not active`, 404);

    let nextActive = cloneJson(active);
    if (frame.commandId === active.commandId) {
      if (frame.relaySequence !== active.offer.sequence) {
        return relayError('host_command_invalid', 'execute acknowledgement references the wrong relay sequence', 409);
      }
      nextActive.acknowledged = true;
    } else if (active.cancel !== null && frame.commandId === active.cancel.commandId) {
      if (frame.relaySequence !== active.cancel.frame.sequence) {
        return relayError('host_command_invalid', 'cancel acknowledgement references the wrong relay sequence', 409);
      }
      nextActive.cancel.acknowledged = true;
    } else {
      return relayError('host_command_invalid', `command ${frame.commandId} does not match the active request`, 409);
    }

    const response = this.#relayFrame(state, state.connectionEpoch, {
      kind: 'accepted',
      inReplyTo: frame.messageId,
      duplicate: false
    }) as AcceptedFrame;
    const next = this.#rememberHostMessage(
      this.#advanceState(state, response, { active: nextActive }),
      frame,
      response
    );
    await this.#persist(next);
    return response;
  }

  async #handleResult(state: HostedRelayDurableState, frame: ResultFrame): Promise<AcceptedFrame> {
    const result = ExecutionResultSchema.parse(frame.result);
    const resultFingerprint = fingerprint(result);
    const terminal = state.terminals.find((entry) => entry.requestId === result.requestId);
    if (terminal !== undefined) {
      if (terminal.resultFingerprint !== resultFingerprint) {
        return relayError(
          'host_terminal_collision',
          `request ${result.requestId} already has a different terminal result`,
          409
        );
      }
      const duplicate = this.#relayFrame(state, state.connectionEpoch, {
        kind: 'accepted',
        inReplyTo: frame.messageId,
        duplicate: true
      }) as AcceptedFrame;
      const next = this.#rememberHostMessage(this.#advanceState(state, duplicate), frame, duplicate);
      await this.#persist(next);
      return duplicate;
    }

    const active = state.active;
    if (active === null || active.request.requestId !== result.requestId) {
      return relayError('host_request_unknown', `request ${result.requestId} is not active`, 404);
    }
    if (frame.commandId !== active.commandId || frame.relaySequence !== active.offer.sequence) {
      return relayError('host_command_invalid', 'terminal result is not bound to the active execute command', 409);
    }
    this.#assertResultBound(state, active.request, result);
    this.#assertCancellationResult(active, result);

    const accepted = this.#relayFrame(state, state.connectionEpoch, {
      kind: 'accepted',
      inReplyTo: frame.messageId,
      duplicate: false
    }) as AcceptedFrame;
    const terminals = [
      ...state.terminals.filter((entry) => entry.requestId !== result.requestId),
      {
        requestId: result.requestId,
        requestFingerprint: active.requestFingerprint,
        resultFingerprint,
        result: cloneJson(result)
      }
    ].slice(-this.#terminalRecordLimit);
    const next = this.#rememberHostMessage(
      this.#advanceState(state, accepted, { active: null, terminals }),
      frame,
      accepted
    );
    await this.#persist(next);
    return accepted;
  }

  async #handleHeartbeat(state: HostedRelayDurableState, frame: HeartbeatFrame): Promise<RelayToHostFrame> {
    if (frame.lastRelaySequence !== state.lastRelaySequence) {
      return relayError(
        'host_resync_required',
        `heartbeat cursor ${frame.lastRelaySequence} does not match ${state.lastRelaySequence}`,
        409,
        HOST_SOCKET_CLOSE_CODES.resyncRequired
      );
    }
    const expiresAt = new Date(this.#clock().valueOf() + this.#heartbeatTtlMs).toISOString();
    const response = this.#relayFrame(state, state.connectionEpoch, {
      kind: 'heartbeat-ack',
      inReplyTo: frame.messageId,
      expiresAt
    });
    const next = this.#rememberHostMessage(this.#advanceState(state, response), frame, response);
    await this.#persist(next);
    return response;
  }

  async #redeliverExecute(state: HostedRelayDurableState): Promise<OfferFrame> {
    const active = state.active;
    if (active === null) return relayError('host_request_unknown', 'there is no active request', 404);
    const offer = this.#relayFrame(state, state.connectionEpoch, {
      kind: 'offer',
      commandId: active.commandId,
      request: cloneJson(active.request)
    }) as OfferFrame;
    const next = this.#advanceState(state, offer, {
      active: { ...active, offer }
    });
    await this.#persist(next);
    return offer;
  }

  async #redeliverCancel(state: HostedRelayDurableState): Promise<CancelFrame> {
    const active = state.active;
    const stored = active?.cancel;
    if (active === null || stored === null || stored === undefined) {
      return relayError('host_request_unknown', 'there is no pending cancellation', 404);
    }
    const cancel = this.#relayFrame(state, state.connectionEpoch, {
      kind: 'cancel',
      commandId: stored.commandId,
      requestId: active.request.requestId,
      reason: stored.reason
    }) as CancelFrame;
    const next = this.#advanceState(state, cancel, {
      active: {
        ...active,
        cancel: { ...stored, frame: cancel }
      }
    });
    await this.#persist(next);
    return cancel;
  }

  #assertPrincipal(principalValue: unknown, hello: HelloFrame): HostedRelayPrincipal {
    const principal = parsePrincipal(principalValue);
    if (Date.parse(principal.expiresAt) <= this.#clock().valueOf()) {
      return relayError(
        'host_authorization_expired',
        'the enrolled host principal has expired',
        401,
        HOST_SOCKET_CLOSE_CODES.authenticationFailed
      );
    }
    if (
      principal.hostId !== hello.hostId ||
      principal.generation !== hello.generation ||
      principal.manifestDigest !== hello.manifestDigest
    ) {
      return relayError('host_identity_stale', 'hello frame does not match the enrolled host principal', 409);
    }
    return principal;
  }

  #assertStoredHost(state: HostedRelayDurableState, hello: HelloFrame): void {
    if (hello.hostId !== state.hostId) {
      relayError('host_identity_stale', `relay object is locked to host ${state.hostId}`, 409);
    }
    if (hello.generation < state.generation) {
      relayError(
        'host_identity_stale',
        `host generation ${hello.generation} is stale; current generation is ${state.generation}`,
        409,
        HOST_SOCKET_CLOSE_CODES.hostGenerationStale
      );
    }
    if (hello.generation === state.generation && hello.manifestDigest !== state.manifestDigest) {
      relayError('host_manifest_changed', 'host manifest changed without advancing the generation', 409);
    }
  }

  #assertRequestCompatible(descriptor: HostDescriptor, request: ExecutionRequest): void {
    if (descriptor.state !== 'ready') {
      relayError('host_connection_unavailable', `host ${descriptor.hostId} is ${descriptor.state}`, 503);
    }
    if (!descriptor.profiles.includes(request.profile) || !descriptor.operations.includes(request.operation)) {
      relayError(
        'host_command_invalid',
        `host ${descriptor.hostId} does not advertise ${request.profile} with ${request.operation}`,
        409
      );
    }
    if (
      request.limits.wallMs > descriptor.limits.maxWallMs ||
      request.limits.outputBytes > descriptor.limits.maxOutputBytes
    ) {
      relayError('host_command_invalid', 'request limits exceed the enrolled host descriptor', 400);
    }
  }

  #assertResultBound(state: HostedRelayDurableState, request: ExecutionRequest, result: ExecutionResult): void {
    if (
      result.runtime.hostId !== state.hostId ||
      result.runtime.hostGeneration !== state.generation ||
      result.runtime.backend !== state.descriptor.backend ||
      result.runtime.runtimeBuild !== state.descriptor.runtimeBuild ||
      result.runtime.haraVersion !== state.descriptor.haraVersion
    ) {
      relayError('host_result_invalid', 'terminal result runtime identity does not match the enrolled host', 409);
    }
    if (result.evidence.profile !== request.profile || result.evidence.sourceDigest !== request.sourceDigest) {
      relayError('host_result_invalid', 'terminal result evidence does not match the active request', 409);
    }
    if (outputBytes(result) > request.limits.outputBytes) {
      relayError('host_result_invalid', 'terminal result exceeds the active request output bound', 400);
    }
  }

  #assertCancellationResult(active: NonNullable<HostedRelayDurableState['active']>, result: ExecutionResult): void {
    const cancellation = active.cancel;
    if (cancellation === null) return;
    if (cancellation.reason === 'deadline-exceeded' && result.status !== 'timed-out') {
      relayError('host_result_invalid', 'deadline cancellation requires a timed-out terminal result', 409);
    }
    if (cancellation.reason !== 'deadline-exceeded' && !['cancelled', 'failed'].includes(result.status)) {
      relayError('host_result_invalid', 'cancelled execution returned an incompatible terminal result', 409);
    }
  }

  async #requireConnectedState(frame: Exclude<HostToRelayFrame, HelloFrame>): Promise<HostedRelayDurableState> {
    const state = await this.#load();
    if (state === null || !state.connected || state.connectionEpoch === null) {
      return relayError('host_connection_unavailable', 'there is no active hosted relay connection', 503);
    }
    if (
      frame.hostId !== state.hostId ||
      frame.generation !== state.generation ||
      frame.connectionEpoch !== state.connectionEpoch
    ) {
      return relayError(
        'host_connection_replaced',
        'host frame belongs to a stale connection epoch or generation',
        409,
        HOST_SOCKET_CLOSE_CODES.resyncRequired
      );
    }
    return state;
  }

  async #requireLiveState(): Promise<HostedRelayDurableState> {
    const state = await this.#load();
    if (state === null || !state.connected || state.connectionEpoch === null) {
      return relayError('host_connection_unavailable', 'there is no active hosted relay connection', 503);
    }
    return state;
  }

  #initialState(hello: HelloFrame, terminals: HostedRelayDurableState['terminals']): HostedRelayDurableState {
    return HostedRelayDurableStateSchema.parse({
      protocol: HOSTED_RELAY_DEPLOYMENT_PROTOCOL,
      revision: 0,
      hostId: hello.hostId,
      generation: hello.generation,
      manifestDigest: hello.manifestDigest,
      descriptor: cloneJson(hello.descriptor),
      connectionEpoch: null,
      connected: false,
      lastRelaySequence: -1,
      lastRelayFrame: null,
      active: null,
      terminals: terminals.slice(-this.#terminalRecordLimit),
      hostMessages: [],
      updatedAt: this.#clock().toISOString()
    });
  }

  #resyncFrame(
    state: HostedRelayDurableState,
    hello: HelloFrame,
    reason: 'cursor-stale' | 'connection-replaced'
  ): ResyncFrame {
    return parseRelayToHostFrame({
      protocol: HOST_SOCKET_PROTOCOL,
      kind: 'resync-required',
      messageId: this.#nextMessageId(),
      connectionEpoch: hello.connectionEpoch,
      hostId: state.hostId,
      generation: state.generation,
      sequence: Math.max(0, hello.resumeAfter + 1),
      reason,
      retryAfterMs: 0
    }) as ResyncFrame;
  }

  async #persistHelloResponse(
    state: HostedRelayDurableState,
    hello: HelloFrame,
    response: ReadyFrame | ResyncFrame
  ): Promise<ReadyFrame | ResyncFrame> {
    const next = this.#rememberHostMessage(
      this.#advanceState(state, response, {
        descriptor: cloneJson(hello.descriptor),
        connectionEpoch: hello.connectionEpoch,
        connected: response.kind === 'ready'
      }),
      hello,
      response
    );
    await this.#persist(next);
    return response;
  }

  #relayFrame(
    state: HostedRelayDurableState,
    connectionEpoch: string | null,
    body: Record<string, unknown>
  ): RelayToHostFrame {
    if (connectionEpoch === null) {
      relayError('host_connection_unavailable', 'host connection epoch is unavailable', 503);
    }
    return parseRelayToHostFrame({
      protocol: HOST_SOCKET_PROTOCOL,
      messageId: this.#nextMessageId(),
      connectionEpoch,
      hostId: state.hostId,
      generation: state.generation,
      sequence: state.lastRelaySequence + 1,
      ...body
    });
  }

  #advanceState(
    state: HostedRelayDurableState,
    frame: RelayToHostFrame,
    patch: Partial<HostedRelayDurableState> = {}
  ): HostedRelayDurableState {
    return this.#nextRevision(state, {
      ...patch,
      lastRelaySequence: frame.sequence,
      lastRelayFrame: cloneJson(frame)
    });
  }

  #nextRevision(
    state: HostedRelayDurableState,
    patch: Partial<HostedRelayDurableState>
  ): HostedRelayDurableState {
    return HostedRelayDurableStateSchema.parse({
      ...state,
      ...patch,
      revision: state.revision + 1,
      updatedAt: this.#clock().toISOString()
    });
  }

  #duplicateHostMessage(state: HostedRelayDurableState, frame: HostToRelayFrame): RelayToHostFrame | null {
    const previous = state.hostMessages.find((entry) => entry.messageId === frame.messageId);
    if (previous === undefined) return null;
    if (previous.frameFingerprint !== fingerprint(frame)) {
      return relayError(
        'host_message_collision',
        `host message ID ${frame.messageId} was reused with changed content`,
        409
      );
    }
    return cloneJson(previous.response);
  }

  #rememberHostMessage(
    state: HostedRelayDurableState,
    frame: HostToRelayFrame,
    response: RelayToHostFrame
  ): HostedRelayDurableState {
    const entry = {
      messageId: frame.messageId,
      frameFingerprint: fingerprint(frame),
      response: cloneJson(response)
    };
    return HostedRelayDurableStateSchema.parse({
      ...state,
      hostMessages: [
        ...state.hostMessages.filter((item) => item.messageId !== frame.messageId),
        entry
      ].slice(-this.#hostMessageLimit)
    });
  }

  async #load(): Promise<HostedRelayDurableState | null> {
    if (this.#cache !== undefined) return this.#cache;
    const raw = await this.#store.load();
    if (raw === null) {
      this.#cache = null;
      return null;
    }
    try {
      this.#cache = HostedRelayDurableStateSchema.parse(raw);
      return this.#cache;
    } catch (error) {
      return relayError('host_relay_storage_invalid', firstValidationMessage(error), 500);
    }
  }

  async #persist(state: HostedRelayDurableState): Promise<void> {
    const parsed = HostedRelayDurableStateSchema.parse(state);
    await this.#store.save(cloneJson(parsed));
    this.#cache = parsed;
  }

  #snapshot(state: HostedRelayDurableState | null): HostedRelaySnapshot {
    return Object.freeze({
      protocol: HOSTED_RELAY_DEPLOYMENT_PROTOCOL,
      hostId: state?.hostId ?? null,
      generation: state?.generation ?? null,
      connected: state?.connected ?? false,
      connectionEpoch: state?.connectionEpoch ?? null,
      lastRelaySequence: state?.lastRelaySequence ?? -1,
      activeRequestId: state?.active?.request.requestId ?? null,
      executeAcknowledged: state?.active?.acknowledged ?? false,
      cancelPending: state?.active?.cancel !== null && state?.active?.cancel !== undefined,
      cancelAcknowledged: state?.active?.cancel?.acknowledged ?? false,
      terminalCount: state?.terminals.length ?? 0,
      revision: state?.revision ?? 0
    });
  }

  #clock(): Date {
    return dateValue(this.#now(), 'host relay clock');
  }

  #nextMessageId(): string {
    return RequestIdSchema.parse(this.#messageId());
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
