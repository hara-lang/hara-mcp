# hara-mcp

Language-owned MCP gateway and execution-host coordination for Hara.

The architecture and six-phase delivery plan are tracked in [issue #1](https://github.com/hara-lang/hara-mcp/issues/1). The active implementation slice is [issue #8](https://github.com/hara-lang/hara-mcp/issues/8).

## Current status

This branch contains the first MCP and host-routing scaffold. It does not yet provide a production endpoint or prove real Hara execution. The deterministic host is a disabled-by-default transport fixture; Phase 1 remains open until an unpacked Hara Chrome host executes the request in a restricted Wasm Sandbox.

## Development

Node.js 22 is required.

```sh
npm install
npm run check
```

Start the stdio server with no registered host:

```sh
npm run dev
```

Enable the deterministic transport fixture for MCP Inspector development only:

```sh
HARA_MCP_ENABLE_TEST_FIXTURE=1 npm run dev
```

The initial catalogue is:

```text
hara_runtime_get
hara_eval
hara_call
hara_check
```

All four tools are declared read-only, non-destructive, and closed-world. No option enables browser, network, persistent filesystem, package, process, provider, or external-effect authority.

## Boundaries

- Hara owns execution semantics and the canonical Sandbox/LiveSession lifecycle.
- Hara Chrome is an enrolled execution host, not an MCP server.
- `mcp.greenways.ai` remains a Greenways application ingress and consumes the lower-level Hara host protocol directly when needed.
- MCP and host/device credentials terminate at independent boundaries.

See [the architecture note](docs/architecture.md) and [AGENTS.md](AGENTS.md) before making changes.
