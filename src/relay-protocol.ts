import * as z from 'zod/v4';

import {
  ExecutionRequestSchema,
  ExecutionResultSchema,
  HostDescriptorSchema,
  IdentifierSchema,
  RequestIdSchema
} from './protocol.js';

export const LOOPBACK_RELAY_PROTOCOL = 'hara.loopback-relay/0-alpha' as const;
export const LOOPBACK_RELAY_BIND_ADDRESS = '127.0.0.1' as const;
export const LOOPBACK_RELAY_MAX_BODY_BYTES = 1_310_720;
export const LOOPBACK_RELAY_DEFAULT_PORT = 8765;
export const LOOPBACK_RELAY_DEFAULT_HOST_TTL_MS = 5_000;
export const LOOPBACK_RELAY_DEFAULT_POLL_MS = 250;
export const LOOPBACK_RELAY_MAX_POLL_MS = 5_000;

export const RelayHostIdentitySchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    hostId: IdentifierSchema,
    generation: z.number().int().nonnegative()
  })
  .strict();
export type RelayHostIdentity = z.infer<typeof RelayHostIdentitySchema>;

export const RelayRegisterRequestSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    descriptor: HostDescriptorSchema
  })
  .strict();
export type RelayRegisterRequest = z.infer<typeof RelayRegisterRequestSchema>;

export const RelayRegisterResponseSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    accepted: z.literal(true),
    hostId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    heartbeatTtlMs: z.number().int().positive().max(60_000),
    pollAfterMs: z.number().int().positive().max(LOOPBACK_RELAY_MAX_POLL_MS)
  })
  .strict();
export type RelayRegisterResponse = z.infer<typeof RelayRegisterResponseSchema>;

export const RelayPollRequestSchema = RelayHostIdentitySchema.extend({
  waitMs: z.number().int().nonnegative().max(LOOPBACK_RELAY_MAX_POLL_MS).default(0),
  acknowledgedCommandId: IdentifierSchema.optional()
}).strict();
export type RelayPollRequest = z.infer<typeof RelayPollRequestSchema>;

export const RelayIdleCommandSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    kind: z.literal('idle'),
    retryAfterMs: z.number().int().positive().max(LOOPBACK_RELAY_MAX_POLL_MS)
  })
  .strict();

export const RelayExecuteCommandSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    kind: z.literal('execute'),
    commandId: IdentifierSchema,
    request: ExecutionRequestSchema
  })
  .strict();

export const RelayCancelCommandSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    kind: z.literal('cancel'),
    commandId: IdentifierSchema,
    requestId: RequestIdSchema,
    reason: z.enum(['client-cancelled', 'deadline-exceeded', 'relay-closing'])
  })
  .strict();

export const RelayCommandSchema = z.discriminatedUnion('kind', [
  RelayIdleCommandSchema,
  RelayExecuteCommandSchema,
  RelayCancelCommandSchema
]);
export type RelayCommand = z.infer<typeof RelayCommandSchema>;

export const RelayResultRequestSchema = RelayHostIdentitySchema.extend({
  result: ExecutionResultSchema
}).strict();
export type RelayResultRequest = z.infer<typeof RelayResultRequestSchema>;

export const RelayAcceptedResponseSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    accepted: z.literal(true),
    duplicate: z.boolean()
  })
  .strict();
export type RelayAcceptedResponse = z.infer<typeof RelayAcceptedResponseSchema>;

export const RelayHealthResponseSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    status: z.literal('ok'),
    hostState: z.enum(['unknown', 'ready', 'degraded', 'offline', 'revoked']),
    activeRequest: z.boolean()
  })
  .strict();
export type RelayHealthResponse = z.infer<typeof RelayHealthResponseSchema>;

export const RelayErrorCodeSchema = z.enum([
  'authentication_failed',
  'origin_forbidden',
  'invalid_request',
  'body_too_large',
  'host_collision',
  'host_incompatible',
  'host_generation_stale',
  'host_manifest_changed',
  'request_busy',
  'request_unknown',
  'request_terminal',
  'terminal_collision',
  'method_not_allowed',
  'not_found',
  'relay_closed',
  'internal_error'
]);
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;

export const RelayErrorResponseSchema = z
  .object({
    protocol: z.literal(LOOPBACK_RELAY_PROTOCOL),
    accepted: z.literal(false),
    error: z
      .object({
        code: RelayErrorCodeSchema,
        message: z.string().min(1).max(4_096)
      })
      .strict()
  })
  .strict();
export type RelayErrorResponse = z.infer<typeof RelayErrorResponseSchema>;
