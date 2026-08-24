# Hosted Hara execution-host socket

Issue `#12` freezes the first production transport boundary for an enrolled Hara execution host.

```text
Hara Chrome
  -> wss://mcp.hara-lang.org/relay/host/v1
  -> hara.host.v1
  -> hara.host-socket/0-alpha frames
  -> selected host route and gateway lifecycle
```

This is a host transport, not an MCP client transport. The public MCP endpoint remains:

```text
https://mcp.hara-lang.org/mcp
```

## Exact endpoint

Production hosts connect to exactly:

```text
wss://mcp.hara-lang.org/relay/host/v1
```

The client rejects:

- `ws` downgrade;
- another hostname, including the superseded `relay.hara-lang.org` hostname;
- an explicit alternate or default port;
- a sibling or trailing-slash path;
- URL credentials;
- query strings or fragments; and
- redirects or runtime-selected production relay URLs.

The exact WebSocket subprotocol is:

```text
hara.host.v1
```

A separately selected development profile may use only:

```text
ws://127.0.0.1:<port>/relay/host/v1
```

`localhost`, wildcard, IPv6 loopback, LAN, public and TLS development addresses remain invalid. The existing Phase 1 HTTP long-poll relay remains a local compatibility proof and is not the production socket contract.

## Credential boundary

Host authentication is part of the WebSocket upgrade and terminates at the relay route. Device credentials, pairing secrets and proof material are prohibited from every host descriptor, socket frame, execution request, result, diagnostic, MCP response and ordinary log.

The MCP client authenticates independently at `/mcp`. Its bearer credential has a different audience and is never forwarded to the execution host.

## Closed frame family

Every application frame is bounded UTF-8 JSON and carries:

```text
protocol
kind
messageId
connectionEpoch
hostId
host generation
```

Relay-to-host frames also carry one monotonic `sequence`.

Host to relay:

```text
hello
ack
result
heartbeat
```

Relay to host:

```text
ready
offer
cancel
accepted
heartbeat-ack
resync-required
error
```

Unknown fields, frame kinds, versions and incompatible nested Hara values fail closed. Binary frames are not part of this revision. The application frame limit is 1,310,720 UTF-8 bytes, below the platform WebSocket maximum.

## Identity and ordering

A connection epoch is a new UUID for one socket lifetime. Every frame must match the enrolled host ID and current host generation.

The host sequence fence applies these laws:

1. the next relay frame is `lastSequence + 1`;
2. exact redelivery of the current sequence and content is an idempotent duplicate;
3. changed content at the same sequence is a collision;
4. an older sequence is stale; and
5. a skipped sequence requires resynchronisation.

A reconnect does not imply permission to replay accepted execution. The relay either resumes from an accepted cursor or emits `resync-required`. Host generation replacement, connection takeover and relay restart are explicit reasons rather than implicit retries.

## Execution binding

`hello` binds the socket identity to the enclosed `hara.execution-host/0-alpha` descriptor and manifest digest.

`offer` carries one closed Hara execution request. `ack` acknowledges the stable command identity and relay sequence. Commands may be redelivered until acknowledged.

`result` carries one closed Hara execution result and must match the frame host ID and generation. The existing coordinator additionally binds request identity, source digest, runtime build, profile, limits and immutable terminal settlement.

Cancellation is a separate command and acknowledgement. A cancelled or expired request cannot later settle successfully. Identical terminal redelivery is idempotent; changed terminal content is a collision.

## Deployment boundary

The protocol module is runtime-neutral. A hosted implementation should route a validated upgrade to one stateful coordination object per enrolled host, persist fencing and terminal records before updating in-memory state, and allow an idle socket owner to hibernate without disconnecting the host.

Production deployment remains disabled until Phase 3 supplies:

- user-mediated pairing;
- proof-of-possession host identity;
- short-lived exact-audience connection authorization;
- replacement and revocation;
- durable host generation and presence;
- restart and resynchronisation evidence;
- rate and resource limits; and
- DNS, TLS, observability, rollback and recovery proof.

There is no hosted evaluator fallback. An unavailable enrolled host produces a truthful unavailable state.
