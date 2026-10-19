# G5 Source Gate — local Fake HTTP and thin turn orchestration

- Date: 2026-10-03 (Asia/Shanghai)
- Scope: G5 local, process-local Fake HTTP only
- Decision: **PASS for implementation of the local Fake path; NOT PASSED for production, durable, multi-instance, or real-provider claims**
- External activity: documentation and repository review only; no provider call, paid call, credential read, dependency install, or copied upstream code

## 1. Decision

The repository already contains the primitives needed to expose a local Fake HTTP surface through the installed Next.js 14 Route Handler runtime. G5 should use the existing Next.js dependency and add a thin, fixed-order orchestrator over the governed session/evidence stores, lease/cancellation primitives, G2 policy, G4 response runtime, and injected scripted Fakes.

No workflow framework, payment SDK, HTTP framework, persistence library, or provider SDK is needed for this gate. The new HTTP layer must remain an adapter: authenticate, exact-key parse a minimal client command, call the orchestrator, and map its frozen result to HTTP. It must not become a second source of identity, policy, retry, or cancellation authority.

This decision is intentionally limited to a single Node.js process and Fake providers. Current in-memory maps cannot support restart recovery, multiple workers/instances, or durable replay. Those capabilities require a later store adapter and a separate production gate.

## 2. Repository evidence

| Area | Current evidence | What G5 can reuse | Boundary that remains |
|---|---|---|---|
| Next.js HTTP | `package.json:29` pins `next` to `14.2.3`. Existing handlers already use `app/**/route.ts`, `Request`/`Response`, JSON bodies, and native `ReadableStream`; see `src/app/api/conversation/message/stream/route.ts:26-122`. | A versioned `POST` Route Handler and native JSON `Response`; direct handler invocation with a Web `Request` is sufficient for deterministic Fake HTTP tests. | The legacy conversation route does not use `request.signal`, accepts loosely coerced body fields, and streams unvalidated model deltas at lines 31-33 and 64-70. It is evidence that the platform works, not a template for G5 semantics. |
| Governed session store | `src/lib/turn-orchestrator/session-store.ts:385-398` owns process-local sessions, idempotency indexes, opaque handles, and bound-turn indexes. `startSession` scopes start replay to trusted authority and rejects token/payload conflict (`:409-462`). `openTurn` mints epoch/turn/generation/invocation/response identity server-side (`:465-509`). CAS rejects stale versions (`:511-533`), and mode transitions require a trusted internal operation (`:536-569`). | Server-minted session/turn identity, idempotent start/open, explicit mode transition, state CAS, pause/resume/end transitions, and opaque handles. | All data is memory-only. HTTP must not expose `TrustedSessionAuthority`, `TrustedSessionCasRequest`, opaque handles, state version mutation, or server-minted identity as caller-writable fields. |
| Final evidence | `src/lib/turn-orchestrator/evidence-store.ts:191-218` keeps ASR partials non-final. Typed text and ASR final create immutable, bound evidence and enforce token/fingerprint consistency (`:220-296`). | One canonical final evidence reference for typed text or ASR final before policy/response work begins. | Raw or partial ASR text must never be accepted by the policy/response path as final evidence. The HTTP adapter may transport bytes/text but cannot mint an evidence ref or relabel its provenance. |
| Trusted G4 resolvers | `src/lib/turn-orchestrator/resolvers.ts:86-130` derives DailyChat access/reference context from the bound governed turn. `:132-212` derives the full interview policy request from the same bound identity/evidence. | G4 receives trusted scope and immutable evidence without accepting caller-supplied actor, subject, family, authorization, visibility, or policy fields. | The HTTP body must contain neither a naked DailyChat plan/context nor a full `LiveInterviewDecisionRequest`. |
| Cancellation | `src/lib/algorithm-runtime/cancellation-registry.ts:129-218` supersedes stale generations, issues exact leases/borrowed permits, exposes the canonical signal, and finalizes attempts. `src/lib/algorithm-runtime/lease-tree.ts:236-254` makes mutation authority capability-based and process-local. | One session/turn root with owned children; interrupt/end cancels the canonical tree/registry so late events fail acceptance. | A `NextRequest` inherits the Web `Request` API and therefore has a `signal`, but framework documentation alone does not prove socket-disconnect propagation in this exact Next 14.2.3 harness. A local regression must prove it. `request.signal` is an input to canonical cancellation, not the authority itself. |
| ASR and response cancellation | `src/lib/asr-runtime/doubao-streaming-adapter.ts:102-123` requires an injected transport and explicit `AbortSignal`; `:175-201` propagates abort to transport cancel. `src/lib/response-runtime/runtime.ts:316-420` resolves the trusted interview request internally, acquires/finalizes a lease, suppresses or responds policy-direct when required, and races generation with cancellation. | Injected Fake transport/generator and deterministic cancellation/fallback behavior with no network. | HTTP must never pass provider credentials or select network transports. Cancellation must return without starting a fallback response after the canonical lease is aborted. |
| Offline providers and retry | `src/lib/provider-runtime/scripted-fake.ts:230-254` supplies named ASR/LLM/TTS/memory scripted Fakes. `src/lib/provider-runtime/retry-runner.ts:218-480` owns bounded attempts, ledger completion, accepted/rejected late events, fallback, and final cleanup. | Deterministic scripts for failure, retry, latency, cancellation, and fallback tests. | Do not silently nest `ProviderRetryRunner` under another owner of the same module/generation lease. Until an explicit borrowed-permit bridge is frozen, the local G5 response path should inject the existing one-shot Fake generator. Retry ownership remains in G3. |
| Async work | `src/lib/turn-orchestrator/async-jobs.ts:70-84` defines the turn-scoped coordinator; `:184-232` races work with the lease signal and validates active ownership. | Fake MEMORY/STORY/PROFILE jobs can be children of the governed turn and settled before final close. | Durable adapters must recheck `canCommit()` atomically with their write. An in-memory successful test does not prove durable exactly-once effects. |

### Sufficiency verdict

| Claim | Verdict | Reason |
|---|---|---|
| Local Fake HTTP in one Node.js process | **Sufficient** | Route Handler, governed maps, final evidence, trusted resolvers, cancellation/lease primitives, response runtime, and scripted Fakes already exist. |
| Deterministic 3-session / 24-turn / 10-interrupt harness | **Sufficient, subject to tests** | IDs and state are server-minted; Fake timing is controllable; late acceptance and pending-lease cleanup can be asserted. |
| Browser/client disconnect cancellation | **Unproven until local HTTP regression** | Web `Request.signal` exists, but actual disconnect-to-abort behavior and timing must be observed in the chosen harness. |
| Restart-safe or multi-instance service | **Insufficient** | Current `Map`/`WeakMap` state and opaque capabilities are process-local. |
| Real provider / production retry composition | **Outside this gate** | No real calls are authorized; G3 retry ownership and G4 response lease ownership need an explicit integration contract before nesting. |

## 3. Open-source references

Only mechanisms were studied. No upstream source was copied.

| Reference | Version / license / primary sources | Mechanism to learn | Why no code copy or dependency in G5 |
|---|---|---|---|
| Next.js Route Handlers | Local and upstream tag **14.2.3**; MIT. [v14 Route Handler docs](https://nextjs.org/docs/14/app/building-your-application/routing/route-handlers), [v14.2.3 release](https://github.com/vercel/next.js/releases/tag/v14.2.3), [tagged package metadata](https://github.com/vercel/next.js/blob/v14.2.3/packages/next/package.json), [repository](https://github.com/vercel/next.js) | `app/**/route.ts` handlers use Web `Request`/`Response`, support `POST`, JSON bodies, and native streams. This is enough for a thin HTTP adapter and direct in-process handler tests. | It is already the pinned framework. Copying framework/examples adds nothing. The docs' raw LLM streaming example is not suitable for SGX because policy/schema validation must finish before user-visible text is emitted. |
| Stripe idempotent request semantics / stripe-node | Official API semantics retrieved 2026-10-03; `stripe-node` master package snapshot **23.0.0**; MIT. [Idempotent request docs](https://docs.stripe.com/api/idempotent_requests), [repository](https://github.com/stripe/stripe-node), [package metadata](https://github.com/stripe/stripe-node/blob/master/package.json), [license](https://github.com/stripe/stripe-node/blob/master/LICENSE) | Scope a key to trusted server context; remember the first executed terminal result; replay the same result for the same key/payload; reject key reuse with different parameters; do not cache requests rejected before execution. This matches the repository's fingerprinted operation maps. | The Stripe SDK is a payment/network client with its own transport and retry concerns. G5 needs only the protocol invariant, already implemented locally. Adding it would expand dependencies and could obscure retry ownership. |
| LangGraph.js runtime/checkpoint model | `@langchain/langgraph` main package snapshot **1.4.18**; MIT. [repository](https://github.com/langchain-ai/langgraphjs), [package metadata](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/package.json), [Runtime API](https://langchain-ai.github.io/langgraphjs/reference/interfaces/langgraph.Runtime.html), [license](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE) | Treat `AbortSignal`, interrupt, store/checkpoint identity, and resume as explicit runtime state. Its separation of runtime context from caller input supports SGX's server-owned authority and canonical cancellation design. | G5 has a fixed, small turn pipeline rather than an open graph. LangGraph would add graph/checkpoint abstractions and LangChain dependencies, create a second state authority beside the governed store, and still require SGX-specific identity/policy checks. |

These references satisfy the open-source-first requirement by checking the established framework and mature protocol/runtime designs before implementation. The adopted mechanisms are behavioral invariants, not copied implementation.

## 4. Adopted G5 boundary

The minimum local path is:

1. A Next.js `POST` Route Handler authenticates the caller and exact-key validates a small command.
2. The orchestrator resolves trusted actor/subject/family/authorization/visibility from a server-side adapter, starts or loads the governed session, and opens the turn idempotently.
3. Typed text or ASR final is committed as immutable evidence. ASR partial remains `WAIT` and cannot advance the turn.
4. A canonical turn lease owns response, TTS, retention, and artifact children. A disconnect, explicit interrupt, superseding generation, or session end cancels this tree.
5. The mode chooses exactly one trusted path: DailyChat resolver/runtime or Interview resolver → public policy decision → realizer. The HTTP caller cannot submit a plan, policy decision, topic authority, retention intent, or model purpose.
6. The injected scripted Fake produces offline behavior. User-visible output is delivered only after policy/schema validation; terminal suppression and cancellation produce no model fallback.
7. Accepted async jobs settle or are cancelled, the state update uses CAS, the turn closes, and the stable idempotent result is returned.

### Client-writable versus server-derived fields

The HTTP client may provide only command data needed to identify the desired operation, such as a previously issued opaque `sessionId`, an opaque `idempotencyToken`, typed text or audio/chunk data, and an explicit interrupt/pause/resume/end or mode-switch intent. Exact endpoint schemas must decide the precise subset and reject additional keys.

The following must come from governed stores/resolvers and must never be accepted as client authority: `actorId`, `subjectId`, `familySpaceId`, `authorizationVersion`, `visibilityScope`, `sessionEpoch`, `stateVersion`, `turnId`, `generationId`, `invocationId`, `responseId`, evidence refs/provenance, opaque handles/leases/permits, mode-change evidence, interview state, topic/blocked-topic authority, `DirectionPlan`, `InterviewNextAction`, prompt/schema/purpose selection, retention/no-save policy, retry eligibility, ledger usage, and async-job commit authority.

### HTTP and cancellation rules

- Prefer final JSON for the G5 baseline. If streaming is later required, stream only frozen lifecycle events and policy-approved output; never forward raw provider/model deltas before validation.
- Subscribe to `request.signal` and translate abort into the canonical session/turn cancellation API. Also remove the listener in `finally`, settle/cancel children, close the turn, and assert zero pending leases/jobs.
- Treat a caller abort as advisory evidence that delivery ended. A copied `AbortSignal`, ID, or JSON lease shape conveys no authority; only store-issued opaque handles and canonical registries may mutate state.
- Keep HTTP error codes deterministic: malformed/extra-key request, unauthorized/scope mismatch, idempotency conflict, stale generation/CAS conflict, cancelled, and internal Fake failure must remain distinguishable without returning private authority fields.

## 5. Explicit non-adoptions and legacy traps

- Do not add LangGraph, stripe-node, another router/server framework, persistence library, or provider SDK in G5.
- Do not copy the existing `src/app/api/conversation/message/stream/route.ts` delta loop. It can expose text before final policy/schema checks and does not bind client disconnect to canonical cancellation.
- Do not route G5 through the legacy `src/app/api/voice/realtime/route.ts` state. Its session/provider lifecycle is separate from the new governed epoch/turn/generation identity.
- Do not let an SDK perform hidden retries. G3 `ProviderRetryRunner` remains the sole retry/ledger owner when a later explicit bridge adopts it.
- Do not report local in-memory idempotency as exactly-once execution. It gives same-process replay/conflict detection only; crashes between side effects and map updates remain a production blocker.
- Do not infer production disconnect behavior from the presence of `request.signal`; prove abort propagation in the local HTTP regression and keep an explicit interrupt endpoint/command.

## 6. Implementation gate and stop conditions

G5 local Fake HTTP may proceed without a new dependency if its focused tests prove all of the following:

- exact-key HTTP schemas reject authority/policy/evidence fields and extra keys;
- same idempotency token plus identical payload replays one stable terminal result, while a changed payload conflicts;
- typed text and ASR final produce immutable evidence; partial ASR never advances policy or generation;
- mode, identity, family/auth/visibility scope, epoch, turn, generation, evidence, and policy are resolved server-side;
- interrupt, supersession, end, and an aborted `Request.signal` prevent late delivery/commit and leave zero pending leases/jobs;
- provider/schema failure uses only the frozen policy fallback; cancellation never falls back;
- the frozen 3-session / 24-turn / 10-interrupt scenario remains deterministic and does not share state across sessions;
- no network, environment credential, real provider, or billable path is reachable from the test composition.

Stop and open a new design/source gate before claiming restart recovery, multiple Node workers/instances, durable idempotency/CAS, real-provider integration, or nested G3 retry under G4 response ownership.
