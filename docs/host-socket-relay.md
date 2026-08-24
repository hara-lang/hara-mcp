# Hosted Hara host relay scaffold

This document defines the first stateful deployment adapter for the exact production host socket:

```text
wss://mcp.hara-lang.org/relay/host/v1
Sec-WebSocket-Protocol: hara.host.v1
hara.host-socket/0-alpha
```

The client-visible socket contract is owned by `host-socket-protocol.ts`. The hosted adapter in
`host-socket-relay.ts` adds the deployment gate, enrolled-host route decision, durable lifecycle state, command
redelivery, cancellation, immutable terminal settlement and reconnect fencing required by issue #12.

Production traffic remains disabled by default.

## Authority boundary

Authentication terminates before the application socket is accepted. The deployment adapter receives an already
verified enrolled-host principal containing only:

- host ID;
- host generation;
- manifest digest;
- exact production audience; and
- expiry.

It never accepts or stores the bearer credential, pairing proof, device key, MCP credential or raw authorization
header. The route decision forwarded to the stateful object contains no credential material. Credentials must not be
placed in WebSocket attachments, descriptors, frames, requests, results, diagnostics, logs or MCP output.

The production gate accepts only the HTTPS upgrade request corresponding to the canonical WSS endpoint:

```text
GET https://mcp.hara-lang.org/relay/host/v1
Upgrade: websocket
Sec-WebSocket-Protocol: hara.host.v1
```

Trailing slashes, queries, fragments, alternate paths, methods and protocol lists fail closed.

## Disabled deployment profile

`HOSTED_RELAY_DISABLED_DEPLOYMENT` is the package default. Enabling a deployment requires an explicit replacement
configuration whose closed values still name:

```text
socket URL    wss://mcp.hara-lang.org/relay/host/v1
route URL     https://mcp.hara-lang.org/relay/host/v1
object key    host-id
storage       durable-object-sqlite
hibernation   true
```

This is a code-level enablement gate, not an identity implementation. Public traffic must remain disabled until
pairing, proof of possession, revocation and conformance gates are complete.

## Stateful object mapping

The deployment adapter is deliberately runtime-neutral. A Cloudflare deployment should map it as follows:

```text
parent Worker
  validate exact route, method, upgrade and subprotocol
  authenticate enrolled host outside the frame channel
  route by env.HOST_RELAY.getByName(principal.hostId)
        |
        v
one Durable Object per host ID
  accept the server socket with ctx.acceptWebSocket(...)
  retain host ID, generation and connection epoch in a small attachment
  delegate hello/frame/offer/cancel/result laws to HostedHostSocketRelay
  persist HostedRelayDurableState in one SQLite transaction before sending
```

Invalid upgrade requests should be rejected in the parent Worker before routing to a Durable Object. The stateful
object should use the Hibernation WebSocket API. Connection attachments may retain non-secret routing identity, but
all lifecycle state that must survive eviction or deployment belongs in SQLite-backed object storage.

A storage adapter implements:

```ts
interface HostedRelayStateStore {
  load(): Promise<unknown | null>;
  save(state: HostedRelayDurableState): Promise<void>;
}
```

The object serializes lifecycle mutations. Each mutation validates the entire closed state and saves it before the
new in-memory value becomes authoritative.

## Durable state

One host object retains:

- locked host ID, generation, descriptor and manifest digest;
- active connection epoch and connected/offline state;
- last relay sequence and frame;
- at most one active execution command;
- optional cancellation command and acknowledgement state;
- a bounded immutable terminal-result ledger; and
- a bounded host-message ledger for exact duplicate versus changed-content collision handling.

The public `snapshot()` is deliberately redacted. It exposes request IDs and lifecycle booleans, but never source,
arguments, terminal values, diagnostics or credentials.

## Connection and replay laws

A `hello` must match the enrolled principal and the descriptor identity. Same-generation manifest changes and stale
generations fail closed.

For an exact reconnect cursor with no accepted in-flight execution, the relay returns `ready` and continues the relay
sequence. An unacknowledged command may then be redelivered with the same stable command ID and a new relay sequence.

Once an execute command has been acknowledged, a replacement connection receives `resync-required`; the relay does
not replay the accepted execution. This preserves at-most-once execution acceptance while retaining at-least-once
command delivery before acknowledgement.

Host message IDs are durable and closed:

1. exact same ID and content returns the original relay response;
2. changed content at the same ID is a collision;
3. stale connection epochs fail; and
4. relay sequences advance only after durable persistence.

## Terminal settlement

A result must bind to the active execute command, original offer sequence, request ID, host generation, runtime build,
backend, Hara version, pure profile and source digest. Aggregate projected output remains bounded by the active request.

The first valid terminal result is persisted and clears the active request. An identical later terminal is accepted as
an idempotent duplicate. A changed terminal for the same request ID is a collision.

Deadline cancellation requires a `timed-out` terminal. Other cancellation reasons accept only cancellation-compatible
terminal statuses. Cancellation never fabricates a successful value.

## Deployment sequence

The remaining production work is intentionally split:

1. bind the runtime-neutral store to a SQLite-backed Durable Object;
2. add the parent Worker upgrade/authentication adapter;
3. attach the exact WSS Hara Chrome client;
4. add pairing, proof-of-possession and revocation;
5. run the real browser-to-hosted-relay `(+ 40 2) = 42` proof; and
6. enable the production deployment gate only after all required conformance checks are green.

No hosted evaluator fallback is permitted at any stage.
