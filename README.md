# hara-mcp

Language-owned MCP gateway and execution-host coordination for Hara.

The architecture and six-phase delivery plan are tracked in [issue #1](https://github.com/hara-lang/hara-mcp/issues/1). The gateway scaffold is [issue #8](https://github.com/hara-lang/hara-mcp/issues/8); the active loopback-relay slice is [issue #10](https://github.com/hara-lang/hara-mcp/issues/10).

## Current status

This branch contains the MCP gateway, a closed four-tool catalogue, fail-closed host selection, and the first authenticated loopback relay for an outbound execution host. It does **not** provide a production endpoint or prove real Hara execution.

Two development paths exist, and they are deliberately mutually exclusive:

- a disabled-by-default deterministic transport fixture for MCP schema and routing tests;
- a `127.0.0.1`-only relay that lets an enrolled host register, poll for one bounded request, acknowledge commands, submit a terminal result, and receive cancellation.

Phase 1 remains open until an unpacked Hara Chrome host executes a request in a fresh restricted Rust/Wasm Sandbox. A relay transport result is not semantic evidence.

## Development

Node.js 22 is required.

```sh
npm ci
npm run check
```

Start the stdio MCP server with no registered host:

```sh
npm run dev
```

Enable the deterministic transport fixture for MCP Inspector development only:

```sh
HARA_MCP_ENABLE_TEST_FIXTURE=1 npm run dev
```

Start the stdio server and loopback host relay:

```sh
HARA_MCP_LOOPBACK_TOKEN='replace-with-a-random-development-token' \
HARA_MCP_LOOPBACK_PORT=8765 \
HARA_MCP_LOOPBACK_ORIGIN='chrome-extension://your-extension-id' \
npm run dev
```

`HARA_MCP_LOOPBACK_TOKEN` is required whenever another loopback setting is present. The token must contain at least 16 non-whitespace bytes. It authenticates the local HTTP transport only; it must never enter an execution request, descriptor, result, MCP response, diagnostic, or log.

`HARA_MCP_LOOPBACK_ORIGIN` is optional. When configured, requests carrying an `Origin` header must match it exactly. Wildcards are prohibited. The relay always binds exactly to `127.0.0.1` and refuses wildcard, LAN, or public bind addresses.

See [the loopback relay guide](docs/loopback-relay.md) for the host protocol and lifecycle.

## MCP catalogue

The initial catalogue is exactly:

```text
hara_runtime_get
hara_eval
hara_call
hara_check
```

All four tools are declared read-only, non-destructive, and closed-world. No option enables browser, network, persistent filesystem, package, process, provider, database, shell, or external-effect authority.

MCP request cancellation is propagated through the SDK request signal to the selected execution host. The loopback relay converts it into a distinct, idempotent `cancel` command. Requested wall-clock deadlines use the same path.

## Boundaries

- Hara owns execution semantics and the canonical Sandbox/LiveSession lifecycle.
- Hara Chrome is an enrolled execution host, not an MCP server.
- The loopback relay is a temporary Phase 1 transport adapter, not a second Hara runtime protocol.
- `mcp.greenways.ai` remains a Greenways application ingress and consumes the lower-level Hara host protocol directly when needed.
- MCP client credentials, loopback transport credentials, and execution-host/device credentials terminate at independent boundaries.
- Exact command redelivery is allowed until acknowledgement; the host must de-duplicate by command and request identity.

See [the architecture note](docs/architecture.md) and [AGENTS.md](AGENTS.md) before making changes.
