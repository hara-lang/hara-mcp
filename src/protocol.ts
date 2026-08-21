import * as z from 'zod/v4';

export const EXECUTION_HOST_PROTOCOL = 'hara.execution-host/0-alpha' as const;
export const EXECUTION_RESULT_PROTOCOL = 'hara.execution-result/0-alpha' as const;
export const PURE_PROFILE = 'hara.mcp-pure/0-alpha' as const;

export const DEFAULT_LIMITS = {
  wallMs: 5_000,
  outputBytes: 262_144
} as const;

export const SERVER_MAX_LIMITS = {
  wallMs: 30_000,
  outputBytes: 1_048_576,
  sourceBytes: 65_536
} as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u, 'expected a sha256 digest');
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const RequestIdSchema = z.string().uuid();

export const ExecutionOperationSchema = z.enum(['runtime.get', 'sandbox.eval', 'sandbox.call', 'sandbox.check']);
export type ExecutionOperation = z.infer<typeof ExecutionOperationSchema>;

export const HostStateSchema = z.enum(['ready', 'degraded', 'offline', 'revoked']);
export type HostState = z.infer<typeof HostStateSchema>;

export const HostKindSchema = z.enum(['test-fixture', 'browser-wasm', 'native', 'jvm']);
export type HostKind = z.infer<typeof HostKindSchema>;

export const HostLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().max(16_777_216),
    maxOutputBytes: z.number().int().positive().max(16_777_216),
    maxWallMs: z.number().int().positive().max(300_000)
  })
  .strict();

export const HostDescriptorSchema = z
  .object({
    protocol: z.literal(EXECUTION_HOST_PROTOCOL),
    hostId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    kind: HostKindSchema,
    state: HostStateSchema,
    backend: z.string().min(1).max(128),
    runtimeBuild: DigestSchema,
    haraVersion: z.string().min(1).max(128),
    profiles: z.array(z.string().min(1).max(128)).min(1).max(16),
    operations: z.array(ExecutionOperationSchema).min(1).max(16),
    limits: HostLimitsSchema,
    observedAt: z.string().datetime({ offset: true })
  })
  .strict();
export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;

export const RequestedLimitsSchema = z
  .object({
    wallMs: z.number().int().positive().max(SERVER_MAX_LIMITS.wallMs).optional(),
    outputBytes: z.number().int().positive().max(SERVER_MAX_LIMITS.outputBytes).optional()
  })
  .strict();
export type RequestedLimits = z.infer<typeof RequestedLimitsSchema>;

export const EffectiveLimitsSchema = z
  .object({
    wallMs: z.number().int().positive().max(SERVER_MAX_LIMITS.wallMs),
    outputBytes: z.number().int().positive().max(SERVER_MAX_LIMITS.outputBytes)
  })
  .strict();
export type EffectiveLimits = z.infer<typeof EffectiveLimitsSchema>;

const HostRequestBaseSchema = z.object({
  protocol: z.literal(EXECUTION_HOST_PROTOCOL),
  requestId: RequestIdSchema,
  profile: z.literal(PURE_PROFILE),
  sourceDigest: DigestSchema,
  limits: EffectiveLimitsSchema
});

export const EvalHostRequestSchema = HostRequestBaseSchema.extend({
  operation: z.literal('sandbox.eval'),
  source: z.string().min(1).max(SERVER_MAX_LIMITS.sourceBytes)
}).strict();

export const CallHostRequestSchema = HostRequestBaseSchema.extend({
  operation: z.literal('sandbox.call'),
  namespace: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\s/]+(?:\.[^\s/]+)*$/u),
  symbol: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\s/]+$/u),
  arguments: z.array(JsonValueSchema).max(64),
  source: z.string().max(SERVER_MAX_LIMITS.sourceBytes).optional()
}).strict();

export const CheckProfileSchema = z.enum(['reader', 'compile', 'namespace', 'lint', 'test']);
export type CheckProfile = z.infer<typeof CheckProfileSchema>;

export const CheckHostRequestSchema = HostRequestBaseSchema.extend({
  operation: z.literal('sandbox.check'),
  source: z.string().min(1).max(SERVER_MAX_LIMITS.sourceBytes),
  checkProfile: CheckProfileSchema
}).strict();

export const ExecutionRequestSchema = z.discriminatedUnion('operation', [
  EvalHostRequestSchema,
  CallHostRequestSchema,
  CheckHostRequestSchema
]);
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const DiagnosticSchema = z
  .object({
    code: z.string().min(1).max(128),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(8_192),
    path: z.string().min(1).max(1_024).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional()
  })
  .strict();
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const ValueProjectionSchema = z
  .object({
    text: z.string().max(SERVER_MAX_LIMITS.outputBytes),
    json: JsonValueSchema.optional()
  })
  .strict();
export type ValueProjection = z.infer<typeof ValueProjectionSchema>;

export const RuntimeEvidenceSchema = z
  .object({
    hostId: IdentifierSchema,
    hostGeneration: z.number().int().nonnegative(),
    backend: z.string().min(1).max(128),
    runtimeBuild: DigestSchema,
    haraVersion: z.string().min(1).max(128)
  })
  .strict();

export const ExecutionEvidenceSchema = z
  .object({
    profile: z.literal(PURE_PROFILE),
    sourceDigest: DigestSchema,
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    elapsedMs: z.number().nonnegative().finite(),
    cleanup: z.enum(['completed', 'uncertain'])
  })
  .strict();

export const ExecutionStatusSchema = z.enum(['completed', 'failed', 'cancelled', 'timed-out']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionResultSchema = z
  .object({
    protocol: z.literal(EXECUTION_RESULT_PROTOCOL),
    requestId: RequestIdSchema,
    runId: IdentifierSchema,
    status: ExecutionStatusSchema,
    value: ValueProjectionSchema.nullable(),
    stdout: z.string().max(SERVER_MAX_LIMITS.outputBytes),
    stderr: z.string().max(SERVER_MAX_LIMITS.outputBytes),
    diagnostics: z.array(DiagnosticSchema).max(256),
    runtime: RuntimeEvidenceSchema,
    evidence: ExecutionEvidenceSchema
  })
  .strict();
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const GatewayErrorCodeSchema = z.enum([
  'host_unavailable',
  'host_incompatible',
  'host_result_invalid',
  'host_collision',
  'host_busy',
  'request_invalid',
  'limit_exceeded',
  'capability_unsupported',
  'run_failed',
  'cancelled',
  'timed_out',
  'internal_error'
]);
export type GatewayErrorCode = z.infer<typeof GatewayErrorCodeSchema>;

export const ToolErrorSchema = z
  .object({
    code: GatewayErrorCodeSchema,
    message: z.string().min(1).max(4_096)
  })
  .strict();

export const RuntimeToolResponseSchema = z
  .object({
    ok: z.boolean(),
    host: HostDescriptorSchema.optional(),
    error: ToolErrorSchema.optional()
  })
  .strict()
  .superRefine((response, context) => {
    if (response.ok && response.host === undefined) {
      context.addIssue({ code: 'custom', path: ['host'], message: 'successful runtime response requires host' });
    }
    if (response.ok && response.error !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'successful runtime response cannot contain error'
      });
    }
    if (!response.ok && response.error === undefined) {
      context.addIssue({ code: 'custom', path: ['error'], message: 'failed runtime response requires error' });
    }
    if (!response.ok && response.host !== undefined) {
      context.addIssue({ code: 'custom', path: ['host'], message: 'failed runtime response cannot contain host' });
    }
  });
export type RuntimeToolResponse = z.infer<typeof RuntimeToolResponseSchema>;

export const ExecutionToolResponseSchema = z
  .object({
    ok: z.boolean(),
    result: ExecutionResultSchema.optional(),
    error: ToolErrorSchema.optional()
  })
  .strict()
  .superRefine((response, context) => {
    if (response.ok && response.result === undefined) {
      context.addIssue({ code: 'custom', path: ['result'], message: 'successful execution response requires result' });
    }
    if (response.ok && response.error !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'successful execution response cannot contain error'
      });
    }
    if (!response.ok && response.error === undefined) {
      context.addIssue({ code: 'custom', path: ['error'], message: 'failed execution response requires error' });
    }
    if (!response.ok && response.result !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'failed execution response cannot contain result'
      });
    }
  });
export type ExecutionToolResponse = z.infer<typeof ExecutionToolResponseSchema>;

export const RuntimeGetInputSchema = z.object({}).strict();

export const EvalToolInputSchema = z
  .object({
    source: z.string().min(1).max(SERVER_MAX_LIMITS.sourceBytes),
    limits: RequestedLimitsSchema.optional()
  })
  .strict();
export type EvalToolInput = z.infer<typeof EvalToolInputSchema>;

export const CallToolInputSchema = z
  .object({
    namespace: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\s/]+(?:\.[^\s/]+)*$/u),
    symbol: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\s/]+$/u),
    arguments: z.array(JsonValueSchema).max(64).default([]),
    source: z.string().max(SERVER_MAX_LIMITS.sourceBytes).optional(),
    limits: RequestedLimitsSchema.optional()
  })
  .strict();
export type CallToolInput = z.infer<typeof CallToolInputSchema>;

export const CheckToolInputSchema = z
  .object({
    source: z.string().min(1).max(SERVER_MAX_LIMITS.sourceBytes),
    profile: CheckProfileSchema,
    limits: RequestedLimitsSchema.optional()
  })
  .strict();
export type CheckToolInput = z.infer<typeof CheckToolInputSchema>;
