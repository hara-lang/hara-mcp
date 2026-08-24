import * as z from 'zod/v4';

import {
  DigestSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  HostDescriptorSchema,
  IdentifierSchema,
  RequestIdSchema,
  type HostDescriptor
} from './protocol.js';

export const HOST_SOCKET_PROTOCOL = 'hara.host-socket/0-alpha' as const;
export const HOST_SOCKET_SUBPROTOCOL = 'hara.host.v1' as const;
export const HOST_SOCKET_PATH = '/relay/host/v1' as const;
export const HOST_SOCKET_PRODUCTION_URL = 'wss://mcp.hara-lang.org/relay/host/v1' as const;
export const HOST_SOCKET_MAX_FRAME_BYTES = 1_310_720;
export const HOST_SOCKET_MAX_HEARTBEAT_TTL_MS = 60_000;

export const HOST_SOCKET_CLOSE_CODES = Object.freeze({
  normal: 1000,
  policyViolation: 1008,
  serviceRestart: 1012,
  tryAgainLater: 1013,
  authenticationFailed: 4401,
  forbidden: 4403,
  hostCollision: 4409,
  hostGenerationStale: 4410,
  resyncRequired: 4412
});

export const HostSocketProfileSchema = z.enum(['production', 'development']);
export type HostSocketProfile = z.infer<typeof HostSocketProfileSchema>;

export type HostSocketProtocolErrorCode =
  | 'host_socket_url_invalid'
  | 'host_socket_subprotocol_invalid'
  | 'host_socket_frame_invalid'
  | 'host_socket_frame_too_large'
  | 'host_socket_connection_epoch_stale'
  | 'host_socket_host_identity_stale'
  | 'host_socket_sequence_stale'
  | 'host_socket_sequence_collision'
  | 'host_socket_resync_required';

export class HostSocketProtocolError extends Error {
  readonly code: HostSocketProtocolErrorCode;

  constructor(code: HostSocketProtocolErrorCode, message: string) {
    super(message);
    this.name = 'HostSocketProtocolError';
    this.code = code;
  }
}

function socketError(code: HostSocketProtocolErrorCode, message: string): never {
  throw new HostSocketProtocolError(code, message);
}

export function validateHostSocketUrl(value: string, profile: HostSocketProfile): string {
  const parsedProfile = HostSocketProfileSchema.parse(profile);
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return socketError(
      'host_socket_url_invalid',
      'host socket URL must be a non-empty string of at most 256 characters'
    );
  }

  if (parsedProfile === 'production') {
    if (value !== HOST_SOCKET_PRODUCTION_URL) {
      return socketError(
        'host_socket_url_invalid',
        `production host socket URL must be exactly ${HOST_SOCKET_PRODUCTION_URL}`
      );
    }
    return value;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return socketError('host_socket_url_invalid', 'development host socket URL must be absolute');
  }

  const port = Number(url.port);
  const canonical = `ws://127.0.0.1:${url.port}${HOST_SOCKET_PATH}`;
  if (
    value !== canonical ||
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== HOST_SOCKET_PATH ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return socketError(
      'host_socket_url_invalid',
      `development host socket URL must be exactly ws://127.0.0.1:<port>${HOST_SOCKET_PATH}`
    );
  }
  return value;
}

export function validateHostSocketSubprotocol(value: string): typeof HOST_SOCKET_SUBPROTOCOL {
  if (value !== HOST_SOCKET_SUBPROTOCOL) {
    return socketError(
      'host_socket_subprotocol_invalid',
      `host socket subprotocol must be exactly ${HOST_SOCKET_SUBPROTOCOL}`
    );
  }
  return HOST_SOCKET_SUBPROTOCOL;
}

const HostIdentityFields = {
  protocol: z.literal(HOST_SOCKET_PROTOCOL),
  messageId: RequestIdSchema,
  connectionEpoch: RequestIdSchema,
  hostId: IdentifierSchema,
  generation: z.number().int().nonnegative()
} as const;

const RelayFrameBaseSchema = z.object({
  ...HostIdentityFields,
  sequence: z.number().int().nonnegative()
});

export const HostSocketHelloFrameSchema = z
  .object({
    ...HostIdentityFields,
    kind: z.literal('hello'),
    descriptor: HostDescriptorSchema,
    manifestDigest: DigestSchema,
    resumeAfter: z.number().int().min(-1)
  })
  .strict();

export const HostSocketAckFrameSchema = z
  .object({
    ...HostIdentityFields,
    kind: z.literal('ack'),
    relaySequence: z.number().int().nonnegative(),
    commandId: IdentifierSchema
  })
  .strict();

export const HostSocketResultFrameSchema = z
  .object({
    ...HostIdentityFields,
    kind: z.literal('result'),
    relaySequence: z.number().int().nonnegative(),
    commandId: IdentifierSchema,
    result: ExecutionResultSchema
  })
  .strict();

export const HostSocketHeartbeatFrameSchema = z
  .object({
    ...HostIdentityFields,
    kind: z.literal('heartbeat'),
    lastRelaySequence: z.number().int().min(-1),
    observedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const HostToRelayFrameSchema = z.discriminatedUnion('kind', [
  HostSocketHelloFrameSchema,
  HostSocketAckFrameSchema,
  HostSocketResultFrameSchema,
  HostSocketHeartbeatFrameSchema
]);
export type HostToRelayFrame = z.infer<typeof HostToRelayFrameSchema>;

export const HostSocketReadyFrameSchema = RelayFrameBaseSchema.extend({
  kind: z.literal('ready'),
  inReplyTo: RequestIdSchema,
  heartbeatTtlMs: z.number().int().positive().max(HOST_SOCKET_MAX_HEARTBEAT_TTL_MS),
  resumeAccepted: z.boolean()
}).strict();

export const HostSocketOfferFrameSchema = RelayFrameBaseSchema.extend({
  kind: z.literal('offer'),
  commandId: IdentifierSchema,
  request: ExecutionRequestSchema
}).strict();

export const HostSocketCancelFrameSchema = RelayFrameBaseSchema.extend({
  kind: z.literal('cancel'),
  commandId: IdentifierSchema,
  requestId: RequestIdSchema,
  reason: z.enum(['client-cancelled', 'deadline-exceeded', 'relay-closing'])
}).strict();

export const HostSocketAcceptedFrameSchema = RelayFrameBaseSchema.extend({
  kind: z.literal('accepted'),
  inReplyTo: RequestIdSchema,
  duplicate: z.boolean()
}).strict();

export const HostSocketHeartbeatAckFrameSchema = RelayFrameBaseSchema.extend({
  kind: z.literal('heartbeat-ack'),
  inReplyTo: RequestIdSchema,
  expiresAt: z.string().datetime({ offset: true })
}).strict();

export const HostSocketResyncRequiredFrameSchema = RelayFrameBaseSchema.extend({
  kind: z.literal('resync-required'),
  reason: z.enum(['cursor-stale', 'connection-replaced', 'host-generation-stale', 'relay-restarted']),
  retryAfterMs: z.number().int().nonnegative().max(60_000)
}).strict();

export const HostSocketErrorCodeSchema = z.enum([
  'authentication_failed',
  'host_forbidden',
  'host_collision',
  'host_generation_stale',
  'host_manifest_changed',
  'protocol_incompatible',
  'frame_invalid',
  'frame_too_large',
  'sequence_stale',
  'sequence_collision',
  'request_unknown',
  'request_terminal',
  'terminal_collision',
  'relay_unavailable',
  'internal_error'
]);
export type HostSocketErrorCode = z.infer<typeof HostSocketErrorCodeSchema>;

export const HostSocketErrorFrameSchema = RelayFrameBaseSchema.extend({
  kind: z.literal('error'),
  inReplyTo: RequestIdSchema.optional(),
  error: z
    .object({
      code: HostSocketErrorCodeSchema,
      message: z.string().min(1).max(4_096),
      retryable: z.boolean()
    })
    .strict()
}).strict();

export const RelayToHostFrameSchema = z.discriminatedUnion('kind', [
  HostSocketReadyFrameSchema,
  HostSocketOfferFrameSchema,
  HostSocketCancelFrameSchema,
  HostSocketAcceptedFrameSchema,
  HostSocketHeartbeatAckFrameSchema,
  HostSocketResyncRequiredFrameSchema,
  HostSocketErrorFrameSchema
]);
export type RelayToHostFrame = z.infer<typeof RelayToHostFrameSchema>;

export const HostSocketFrameSchema = z.union([HostToRelayFrameSchema, RelayToHostFrameSchema]);
export type HostSocketFrame = z.infer<typeof HostSocketFrameSchema>;

function assertFrameIdentity(frame: HostSocketFrame): void {
  if (frame.kind === 'hello') {
    if (frame.hostId !== frame.descriptor.hostId || frame.generation !== frame.descriptor.generation) {
      socketError('host_socket_host_identity_stale', 'hello frame identity must match the enclosed host descriptor');
    }
    return;
  }

  if (frame.kind === 'result') {
    if (frame.hostId !== frame.result.runtime.hostId || frame.generation !== frame.result.runtime.hostGeneration) {
      socketError('host_socket_host_identity_stale', 'result frame identity must match its runtime evidence');
    }
  }
}

export function parseHostSocketFrame(value: unknown): HostSocketFrame {
  let frame: HostSocketFrame;
  try {
    frame = HostSocketFrameSchema.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid host socket frame';
    return socketError('host_socket_frame_invalid', message);
  }
  assertFrameIdentity(frame);
  return frame;
}

export function parseHostToRelayFrame(value: unknown): HostToRelayFrame {
  const frame = parseHostSocketFrame(value);
  if (!['hello', 'ack', 'result', 'heartbeat'].includes(frame.kind)) {
    return socketError('host_socket_frame_invalid', `frame ${frame.kind} is not valid from host to relay`);
  }
  return frame as HostToRelayFrame;
}

export function parseRelayToHostFrame(value: unknown): RelayToHostFrame {
  const frame = parseHostSocketFrame(value);
  if (['hello', 'ack', 'result', 'heartbeat'].includes(frame.kind)) {
    return socketError('host_socket_frame_invalid', `frame ${frame.kind} is not valid from relay to host`);
  }
  return frame as RelayToHostFrame;
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

function frameBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function encodeHostSocketFrame(value: unknown): string {
  const frame = parseHostSocketFrame(value);
  const encoded = JSON.stringify(frame);
  if (frameBytes(encoded) > HOST_SOCKET_MAX_FRAME_BYTES) {
    return socketError(
      'host_socket_frame_too_large',
      `host socket frame exceeds ${HOST_SOCKET_MAX_FRAME_BYTES} UTF-8 bytes`
    );
  }
  return encoded;
}

export function decodeHostSocketFrame(value: string): HostSocketFrame {
  if (typeof value !== 'string') {
    return socketError('host_socket_frame_invalid', 'host socket accepts text frames only');
  }
  if (frameBytes(value) > HOST_SOCKET_MAX_FRAME_BYTES) {
    return socketError(
      'host_socket_frame_too_large',
      `host socket frame exceeds ${HOST_SOCKET_MAX_FRAME_BYTES} UTF-8 bytes`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return socketError('host_socket_frame_invalid', 'host socket frame must contain valid JSON');
  }
  return parseHostSocketFrame(parsed);
}

const HostSocketFenceOptionsSchema = z
  .object({
    connectionEpoch: RequestIdSchema,
    hostId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    resumeAfter: z.number().int().min(-1).default(-1)
  })
  .strict();

export interface HostSocketFenceOptions {
  connectionEpoch: string;
  hostId: string;
  generation: number;
  resumeAfter?: number;
}

export interface HostSocketFenceResult {
  frame: RelayToHostFrame;
  duplicate: boolean;
}

export class HostSocketSequenceFence {
  readonly #connectionEpoch: string;
  readonly #hostId: string;
  readonly #generation: number;
  #lastRelaySequence: number;
  #lastFrameCanonical: string | null = null;

  constructor(options: HostSocketFenceOptions) {
    const parsed = HostSocketFenceOptionsSchema.parse(options);
    this.#connectionEpoch = parsed.connectionEpoch;
    this.#hostId = parsed.hostId;
    this.#generation = parsed.generation;
    this.#lastRelaySequence = parsed.resumeAfter;
  }

  acceptRelayFrame(value: unknown): HostSocketFenceResult {
    const frame = parseRelayToHostFrame(value);
    this.#assertIdentity(frame);
    const canonical = JSON.stringify(canonicalValue(frame));

    if (frame.sequence === this.#lastRelaySequence) {
      if (canonical === this.#lastFrameCanonical) return { frame, duplicate: true };
      return socketError(
        'host_socket_sequence_collision',
        `relay sequence ${frame.sequence} was reused with changed content`
      );
    }
    if (frame.sequence < this.#lastRelaySequence) {
      return socketError(
        'host_socket_sequence_stale',
        `relay sequence ${frame.sequence} is older than ${this.#lastRelaySequence}`
      );
    }
    if (frame.sequence !== this.#lastRelaySequence + 1) {
      return socketError(
        'host_socket_resync_required',
        `relay sequence ${frame.sequence} does not follow ${this.#lastRelaySequence}`
      );
    }

    this.#lastRelaySequence = frame.sequence;
    this.#lastFrameCanonical = canonical;
    return { frame, duplicate: false };
  }

  assertHostFrame(value: unknown): HostToRelayFrame {
    const frame = parseHostToRelayFrame(value);
    this.#assertIdentity(frame);
    return frame;
  }

  snapshot(): Readonly<{
    connectionEpoch: string;
    hostId: string;
    generation: number;
    lastRelaySequence: number;
  }> {
    return Object.freeze({
      connectionEpoch: this.#connectionEpoch,
      hostId: this.#hostId,
      generation: this.#generation,
      lastRelaySequence: this.#lastRelaySequence
    });
  }

  #assertIdentity(frame: HostSocketFrame): void {
    if (frame.connectionEpoch !== this.#connectionEpoch) {
      socketError(
        'host_socket_connection_epoch_stale',
        `frame connection epoch ${frame.connectionEpoch} does not match the active connection`
      );
    }
    if (frame.hostId !== this.#hostId || frame.generation !== this.#generation) {
      socketError(
        'host_socket_host_identity_stale',
        `frame host ${frame.hostId} generation ${frame.generation} does not match the active host`
      );
    }
  }
}

export function hostSocketHelloDescriptor(frame: HostToRelayFrame): HostDescriptor | null {
  return frame.kind === 'hello' ? frame.descriptor : null;
}
