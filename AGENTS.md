# Agent instructions

## Scope

This repository owns the MCP gateway, host registry, routing, temporary source/result projection, and protocol adapters for Hara execution hosts. It does not own Hara evaluation semantics, Chrome/browser capabilities, Greenways application records, or a second Sandbox/LiveSession implementation.

## Required boundaries

- Keep the public pure catalogue limited to `hara_runtime_get`, `hara_eval`, `hara_call`, and `hara_check` until its owning issue changes.
- A pure tool must never enable browser, network, persistent filesystem, package, process, database, shell, provider, or external-effect authority through options.
- Never pass MCP bearer credentials to an execution host or device credentials to an MCP client.
- Never silently fall back to a test fixture, hosted evaluator, broader host profile, or trusted local runtime.
- Treat `hara.execution-host/0-alpha` and `hara.mcp-pure/0-alpha` as Hara-owned contracts. Provisional copies in this repository must be replaced by generated or pinned upstream contracts under issue #3.
- The deterministic fixture is transport test evidence only. It must remain disabled by default and identify itself as `test-fixture`.
- Qualified calls invoke an already-loaded Var with transfer-safe arguments. Do not construct call source by concatenating arguments.
- Unknown fields, versions, profiles, capabilities, and lifecycle transitions fail closed.

## Change workflow

1. Read the owning issue and all linked Hara/Greenways contracts.
2. Establish the existing test/build baseline.
3. Keep each pull request independently reviewable and limited to one issue slice.
4. Add negative tests for capability, identity, limit, digest, and lifecycle boundaries touched by the change.
5. Record exact dependency and upstream protocol revisions in the pull request.

## Required validation

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Do not claim real Hara execution until a conforming Hara runtime host has produced the result.
