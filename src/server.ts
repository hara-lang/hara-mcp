import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';

import { GatewayError, type HaraGateway } from './gateway.js';
import {
  CallToolInputSchema,
  CheckToolInputSchema,
  EvalToolInputSchema,
  ExecutionToolResponseSchema,
  RuntimeGetInputSchema,
  RuntimeToolResponseSchema,
  type ExecutionResult,
  type ExecutionToolResponse,
  type GatewayErrorCode,
  type HostDescriptor,
  type RuntimeToolResponse
} from './protocol.js';

export const SERVER_NAME = 'hara-mcp';
export const SERVER_VERSION = '0.1.0-alpha.0';

export const TOOL_NAMES = ['hara_runtime_get', 'hara_eval', 'hara_call', 'hara_check'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const PURE_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
} as const;

function content(text: string): CallToolResult['content'] {
  return [{ type: 'text', text }];
}

function hostResponse(host: HostDescriptor): CallToolResult {
  const response = RuntimeToolResponseSchema.parse({ ok: true, host } satisfies RuntimeToolResponse);
  return {
    content: content(
      `${host.haraVersion} on ${host.kind}/${host.backend}; host ${host.hostId} generation ${host.generation} is ${host.state}.`
    ),
    structuredContent: response
  };
}

function resultResponse(result: ExecutionResult): CallToolResult {
  const response = ExecutionToolResponseSchema.parse({ ok: true, result } satisfies ExecutionToolResponse);
  const value = result.value?.text ?? 'nil';
  const summary =
    result.status === 'completed'
      ? `${value}\n\nRun ${result.runId} completed on ${result.runtime.backend}.`
      : `Run ${result.runId} ended with status ${result.status}.`;
  return {
    content: content(summary),
    structuredContent: response,
    ...(result.status === 'completed' ? {} : { isError: true })
  };
}

function errorResponse(error: unknown): CallToolResult {
  const code: GatewayErrorCode = error instanceof GatewayError ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  const response = ExecutionToolResponseSchema.parse({
    ok: false,
    error: { code, message }
  } satisfies ExecutionToolResponse);
  return {
    content: content(`${code}: ${message}`),
    structuredContent: response,
    isError: true
  };
}

async function handled(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return errorResponse(error);
  }
}

export function createHaraMcpServer(gateway: HaraGateway): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    websiteUrl: 'https://github.com/hara-lang/hara-mcp'
  });

  server.registerTool(
    'hara_runtime_get',
    {
      title: 'Get Hara runtime',
      description:
        'Return the selected compatible Hara execution host, exact runtime build, pure sandbox profile, limits, and observed availability.',
      inputSchema: RuntimeGetInputSchema,
      outputSchema: RuntimeToolResponseSchema,
      annotations: PURE_ANNOTATIONS
    },
    async () => await handled(async () => hostResponse(await gateway.runtimeGet()))
  );

  server.registerTool(
    'hara_eval',
    {
      title: 'Evaluate Hara source',
      description:
        'Evaluate inline Hara source in a fresh restricted, no-network, no-browser, non-persistent sandbox on an enrolled compatible host.',
      inputSchema: EvalToolInputSchema,
      outputSchema: ExecutionToolResponseSchema,
      annotations: PURE_ANNOTATIONS
    },
    async (input) => await handled(async () => resultResponse(await gateway.eval(input)))
  );

  server.registerTool(
    'hara_call',
    {
      title: 'Call a qualified Hara Var',
      description:
        'Invoke an already-loaded fully qualified Hara Var with transfer-safe arguments in a fresh restricted sandbox. Arguments are never concatenated into source.',
      inputSchema: CallToolInputSchema,
      outputSchema: ExecutionToolResponseSchema,
      annotations: PURE_ANNOTATIONS
    },
    async (input) => await handled(async () => resultResponse(await gateway.call(input)))
  );

  server.registerTool(
    'hara_check',
    {
      title: 'Check Hara source',
      description:
        'Run a bounded reader, compile, namespace, lint, or test check in the same fresh restricted pure sandbox profile and return structured diagnostics.',
      inputSchema: CheckToolInputSchema,
      outputSchema: ExecutionToolResponseSchema,
      annotations: PURE_ANNOTATIONS
    },
    async (input) => await handled(async () => resultResponse(await gateway.check(input)))
  );

  return server;
}
