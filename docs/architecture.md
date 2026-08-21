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

The in-memory registry in the first implementation is transport-neutral. A selectable host must:

- use the exact provisional `hara.execution-host/0-alpha` revision;
- be observed in `ready` state;
- advertise the requested operation;
- advertise `hara.mcp-pure/0-alpha`; and
- return a result bound to the selected host ID, generation, profile, request, and source digest.

Missing or incompatible hosts fail explicitly. No hosted evaluator or test fixture is selected implicitly.

## Cancellation

The gateway and host abstraction already carry an `AbortSignal`, and the conformance fixture proves that an aborted request reaches the selected host. The MCP 2.0 tool handler context used by this scaffold does not expose a request abort signal, so this pull request does not pretend that wire-level cancellation is complete. The loopback relay slice in Phase 1 will bind MCP cancellation, host request identity, and `sandbox.cancel` through the frozen execution-host lifecycle.

## Deterministic fixture

`DeterministicTestHost` exists only to prove MCP discovery, validation, routing, and result projection. It recognizes a very small exact request set, identifies itself as `test-fixture`, and is disabled unless `HARA_MCP_ENABLE_TEST_FIXTURE=1` is set for local development.

A fixture result is not evidence that Hara code executed. Phase 1 remains open until a real Hara Chrome restricted Sandbox returns the result.

## Protocol status

The TypeScript schemas in this first slice are provisional adapters for `hara-lang/hara#945`. Phase 2 replaces them with generated or pinned Hara-owned schemas and a cross-provider conformance suite. Downstream code must not treat the provisional shape as an independently owned standard.
