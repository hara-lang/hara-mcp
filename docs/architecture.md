# Architecture

## Ownership

`hara-mcp` is the language-owned MCP ingress and execution-host coordinator:

```text
MCP client
    |
    | MCP transport and client authentication
    v
hara-mcp
  closed tool catalogue
  compatible-host selection
  request routing and cancellation
  bounded result projection
    |
    | hara.execution-host/0-alpha
    v
execution host
    |
    | canonical Hara Sandbox / LiveSession
    v
Hara Runtime
```

The gateway does not evaluate Hara. The first real host is Hara Chrome's offscreen Rust/Wasm runtime. Native and JVM hosts can participate after passing the same Hara-owned execution-host conformance suite.

## Initial pure catalogue

The first catalogue contains exactly:

- `hara_runtime_get`
- `hara_eval`
- `hara_call`
- `hara_check`

Every tool is a fresh, bounded computation under `hara.mcp-pure/0-alpha`:

```text
network             none
browser             none
filesystem          ephemeral read-only source bundle
persistence          none
external effects     none
sandbox reuse        false
```

The gateway does not accept a mode or option that widens these semantics.

## Host selection

The registry is transport-neutral. A selectable host must:

- use the exact provisional `hara.execution-host/0-alpha` revision;
- be observed in `ready` state;
- advertise the requested operation;
- advertise `hara.mcp-pure/0-alpha`; and
- return a result bound to the selected host ID, generation, runtime build, Hara version, profile, request, and source digest.

Missing, offline, degraded, stale, or incompatible hosts fail explicitly. No hosted evaluator or test fixture is selected implicitly.

## Phase 1 loopback relay

The first real transport boundary is `hara.loopback-relay/0-alpha`:

```text
HaraGateway
    |
    | ExecutionHostProtocol
    v
LoopbackRelayCoordinator
    |
    | authenticated JSON over 127.0.0.1
    v
outbound enrolled host
```

The relay exposes only four local endpoints:

```text
GET  /v0/health
POST /v0/host/register
POST /v0/host/poll
POST /v0/host/result
```

It accepts one locked host identity, one current generation, and one non-terminal request. A host-generation advance fences the previous generation and fails any in-flight request. Heartbeat expiry projects `offline`; it never implies successful completion.

The relay binds exactly to `127.0.0.1`, requires an explicit development bearer token for host endpoints, applies closed schemas and body/time limits, and never places the token in protocol records. Optional browser `Origin` validation is exact; wildcard CORS is prohibited.

## Delivery and replay

Execution and cancellation are explicit commands with stable command IDs. A command is redelivered until the host acknowledges it on a later poll or submits the terminal result. This is intentional at-least-once transport delivery over an unreliable HTTP response boundary.

The host must therefore:

- de-duplicate command IDs;
- de-duplicate execution by request ID and request digest;
- acknowledge only commands it has accepted;
- treat cancellation as idempotent; and
- submit exactly one immutable terminal result.

The relay retains a bounded in-memory terminal window. An exact repeated request can replay its known result; reuse of the same request ID with changed content fails. An identical duplicate terminal submission is accepted idempotently, while any changed terminal result is a collision.

## Cancellation

The MCP SDK exposes cancellation through `context.mcpReq.signal`. The three executable tools pass that signal into `HaraGateway`, which passes it to the selected execution host.

For the loopback host:

```text
MCP client abort
  -> MCP request signal
  -> HaraGateway
  -> LoopbackRelayCoordinator
  -> cancel command
  -> enrolled host
```

The request's declared wall-clock deadline enters the same cancellation path with reason `deadline-exceeded`. Once cancellation has settled the caller, a host cannot change the terminal status to `completed`; it must report `cancelled` or `timed-out` consistently with the relay reason.

## Deterministic fixture

`DeterministicTestHost` exists only to prove MCP discovery, validation, routing, and result projection. It recognizes a very small exact request set, identifies itself as `test-fixture`, and is disabled unless `HARA_MCP_ENABLE_TEST_FIXTURE=1` is set for local development.

A fixture result is not evidence that Hara code executed. Phase 1 remains open until a real Hara Chrome restricted Sandbox returns the result.

## Protocol status

The TypeScript schemas remain provisional adapters for `hara-lang/hara#945`. Phase 2 replaces them with generated or pinned Hara-owned schemas and a cross-provider conformance suite. Downstream code must not treat `hara.execution-host/0-alpha`, `hara.mcp-pure/0-alpha`, or the temporary loopback adapter as independently owned standards.
