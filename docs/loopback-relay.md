# Phase 1 loopback relay

## Purpose

The loopback relay connects the local MCP gateway to an outbound execution host without making the browser extension an MCP server and without granting the MCP client browser authority.

```text
MCP client
  -> stdio hara-mcp
  -> HaraGateway
  -> LoopbackRelayCoordinator
  -> http://127.0.0.1:<port>
  <- outbound host register / poll / result
```

The first consumer is Hara Chrome. Until that adapter invokes the canonical restricted Rust/Wasm Sandbox, the relay proves transport behavior only.

## Starting the relay

```sh
HARA_MCP_LOOPBACK_TOKEN='replace-with-a-random-development-token' \
HARA_MCP_LOOPBACK_PORT=8765 \
HARA_MCP_LOOPBACK_ORIGIN='chrome-extension://your-extension-id' \
npm run dev
```

Environment variables:

| Variable                   | Required                  | Meaning                                                                   |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `HARA_MCP_LOOPBACK_TOKEN`  | yes when relay is enabled | Development bearer token for local host endpoints                         |
| `HARA_MCP_LOOPBACK_PORT`   | no                        | TCP port; defaults to `8765`                                              |
| `HARA_MCP_LOOPBACK_ORIGIN` | no                        | Exact allowed browser-extension origin when an `Origin` header is present |

The deterministic test fixture and loopback relay cannot run in the same process. This prevents accidental fallback from a missing real host to fixture output.

## Network boundary

The server always binds exactly to IPv4 loopback:

```text
127.0.0.1
```

It rejects `0.0.0.0`, IPv6-any, LAN addresses, public addresses, wildcard origins, and multiline origins. Host routes require `application/json` and an exact bearer token. The health route is unauthenticated but exposes only protocol version, process status, coarse host state, and whether a request is active.

The token is transport authority only. It is never copied into:

- host descriptors;
- Hara execution requests;
- source bundles;
- results or diagnostics;
- MCP content or structured output; or
- logs.

## Endpoints

### `POST /v0/host/register`

Registers one exact `hara.execution-host/0-alpha` descriptor under the temporary `hara.loopback-relay/0-alpha` envelope.

The first accepted host ID locks the relay for its lifetime. A changed host ID is a collision. The same generation may refresh liveness and state but cannot change its manifest. A higher generation replaces the previous generation and fences its poll/result traffic.

The response returns the accepted host ID and generation, heartbeat TTL, and recommended poll interval.

### `POST /v0/host/poll`

Carries:

```text
protocol
hostId
generation
waitMs
acknowledgedCommandId?
```

It returns one of:

```text
idle
execute {commandId, request}
cancel  {commandId, requestId, reason}
```

`waitMs` is bounded to five seconds. Long polling reduces idle churn while remaining below the default heartbeat TTL.

`execute` and `cancel` are redelivered until acknowledged. The host acknowledges a command by including its exact `commandId` in the next poll. A terminal result also ends delivery. Unknown, unissued, stale-generation, or cross-request acknowledgements fail closed.

Redelivery means the host must keep an idempotency table keyed by command ID and request ID. It must not start a second Sandbox for a duplicate `execute` command.

### `POST /v0/host/result`

Submits one closed `hara.execution-result/0-alpha` terminal result. The relay verifies:

- request ID;
- selected host ID and generation;
- backend, runtime build, and Hara version;
- pure sandbox profile;
- source digest;
- aggregate output bound; and
- cancellation/deadline-consistent terminal status.

An identical duplicate is accepted with `duplicate: true`. A changed result under the same request ID is a terminal collision.

### `GET /v0/health`

Returns only:

```text
protocol
status
hostState
activeRequest
```

It does not return the token, descriptor, source, request, result, runtime build, user identity, or device credential.

## Lifecycle

Host lifecycle:

```text
unknown -> ready | degraded -> offline -> ready | degraded
                             -> replaced by higher generation
```

Request lifecycle:

```text
queued
  -> execute issued
  -> execute acknowledged
  -> running
  -> cancel issued/acknowledged (optional)
  -> completed | failed | cancelled | timed-out
```

The coordinator permits one active request. A second request receives `host_busy`; it is not queued invisibly.

Heartbeat expiry projects `offline` and fails an in-flight request truthfully. A higher host generation also fails the old in-flight request. Neither event fabricates cleanup or completion evidence.

## Replay window

The relay retains a small bounded in-memory terminal window. It stores no durable project or source workspace.

Within that window:

- the same request ID and exact request content return the retained result;
- the same request ID with changed content fails;
- an identical duplicate result is idempotent; and
- a changed result is rejected.

Restarting the process discards this development replay window. Durable restart/recovery belongs to the hosted relay phases, not this local proof.

## Cancellation

MCP tool handlers pass `context.mcpReq.signal` to `HaraGateway`. A client abort therefore becomes a loopback `cancel` command. Request wall-clock expiry produces the same command with `deadline-exceeded`.

The caller settles immediately as cancelled or timed out. The relay retains the active slot for a short bounded cleanup grace period so the host can acknowledge cancellation and report cleanup evidence. A late `completed` result cannot overwrite a cancellation outcome.

## Not included

This slice does not provide:

- a Chrome extension implementation;
- Hara evaluation semantics;
- a trusted local `ROOT` fallback;
- browser, DOM, network, package, shell, database, or provider tools;
- public HTTP serving, TLS, OAuth, account identity, or durable registry;
- persistent source storage; or
- stateful LiveSession tools.

Those boundaries remain owned by the linked Phase 1–6 issues and Hara runtime contracts.
