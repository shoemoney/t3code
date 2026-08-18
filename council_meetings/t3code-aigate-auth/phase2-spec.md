# Phase 2 spec — account hop + muse/kimi route profiles

Builds on Phase 1 (merged on this branch): `ClaudeCredentialBroker.ts` + session-start seam in
`ClaudeAdapter.ts` (~:4160). Council verdict + Phase-1 conventions apply (plan.md, AGENTS.md).
Gate-test results (chair, live, 2026-08-18):

- **T1:** Meta gateway 404s claude slugs (`not_found_error`), accepts `muse-spark-1.2-contributor`
  → route-profile instances must expose their real model via `customModels` (field exists on
  ClaudeSettings, already flows through `providerModelsFromSettings(BUILT_IN_MODELS,
claudeSettings.customModels, DEFAULT_CLAUDE_MODEL_CAPABILITIES)` — `ClaudeProvider.ts:823/913/986`).
- **T2:** SDK `initializationResult().account` = `{tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
apiProvider: "firstParty"}` under injection — surface tokenSource as the brokered-credentials
  honesty check (a PATH-shim or ambient-cred hijack would show a different source). No email in
  this shape; the broker resolution's `account` field is the display name.
- **T3:** after a mid-tool-call interrupt, cross-account resume works and completes the task,
  BUT the resumed model re-executed an already-completed Write despite "don't redo" instructions.
  → **v1 hop NEVER auto-retries the failed/interrupted turn.** Park + announce + let the next
  user message run on the fresh account.

## A. Broker module extensions — `ClaudeCredentialBroker.ts`

1. `resolveBrokerEnvironment` input gains `exclude?: ReadonlyArray<string>` → appended as
   `&exclude=a,b` (comma-joined, URL-encoded) to `/api/select`.
2. New `reportBrokerLimit(input: {brokerUrl, token, account, minutes?})`: POST
   `{url}/api/events/limit` body `{account, minutes?}` (JSON, bearer auth,
   `AbortSignal.timeout(5000)`). Fire-and-forget semantics: returns
   `Effect.Effect<boolean>` (true = 2xx), never fails, never logs tokens. Same fetch style and
   diagnostics pragma as the existing code.
3. Tests in the existing test file's style: exclude param lands on the wire (stub asserts query
   string); reportBrokerLimit posts correct body, survives 500/refused/timeout returning false.

## B. Hop — `ClaudeAdapter.ts` (+ small pure helpers in the broker module)

Design: turn-boundary hop via park-and-teardown. aigate's server-side parking (15m default TTL)
makes the exclude list optional for correctness; pass the dried account as `exclude` on the next
resolution anyway (belt and suspenders for parking latency).

1. **Track the brokered account per session.** At query construction the seam already has the
   resolution; store `{account, brokered: true}` on `ClaudeSessionContext` when `_tag === "ok"`
   (plus the last resolution tag for status). Also record `tried: string[]`.
2. **Classifier** — pure, exported from the broker module for unit testing:
   `classifyClaudeFailure(text: string): "rate-limit" | "overloaded" | "other"`.
   rate-limit: `/rate.?limit|usage limit|too many requests|429|quota|reached your (usage|limit)/i`;
   overloaded (do NOT park — Anthropic-global load shed): `/overloaded|529/i` checked FIRST.
   (Mirrors the field-proven warden classifier.)
3. **Hook point:** where a turn completes as failed with an error message (the
   `handleResultMessage` error path near `ClaudeAdapter.ts:2991`, and the runtime-error
   completion near :3629 if the message text is available there). When session is brokered AND
   classifier says "rate-limit":
   - fire `reportBrokerLimit` (forked/daemon, non-blocking),
   - append account to `tried`,
   - emit a runtime event announcing the hop state (research the existing
     `ProviderRuntimeEvent` vocabulary — reuse the closest existing event type/shape; a thread-
     visible notice like auth.status is the model; do NOT invent a new contract type unless
     nothing fits, and if one must be added, add it properly in packages/contracts),
   - schedule query teardown so the SESSION ends cleanly at the turn boundary (reuse the
     existing stream-end/teardown path around :3618-3723 — do not kill mid-write; the turn is
     already complete when this fires).
4. **Re-entry:** the next sendTurn/startSession for that thread reconstructs the query through
   the EXISTING resume-cursor machinery (`readClaudeResumeState`) and the EXISTING broker seam —
   now passing `exclude: tried` (carry `tried` in an adapter-scoped Map<ThreadId, string[]>
   with entries dropped once a resolution succeeds on a fresh account; document that it is
   in-memory best-effort — aigate parking is the real guard). VERIFY (don't assume) that a
   torn-down session restarts on next turn via resume cursor; if the service layer needs a nudge,
   keep it minimal and cite the existing restart path you found.
5. **No auto-retry** of the failed turn (T3). No hopping for non-brokered instances. 529 →
   nothing (existing behavior stands).
6. **Status surface:** extend the capabilities/status probe path (`ClaudeProvider.ts:732-975`)
   minimally: when instance is brokered, include the last resolution account + the SDK
   tokenSource so clients can render "via broker: <account>". Only if it fits the existing
   ServerProvider draft shape without contract surgery; otherwise leave status untouched and
   note it in the return.
7. The string "aigate" still must not appear in ClaudeAdapter.ts.

## C. Route profiles — muse/kimi (docs + smallest possible enablement)

1. RESEARCH FIRST: how does a user set `customModels` today? (field exists on Claude/Codex/
   Cursor/Grok/OpenCode settings, `providerSettingsForm: {hidden: true}`). Find the web UI or
   flow that manages it (grep apps/web + packages/client-runtime for customModels). If a UI
   exists → document it. If genuinely unreachable from any client, the smallest enablement is
   removing `hidden` for the Claude driver ONLY — decide on evidence and say which you did.
2. Docs (`docs/user/providers-claude.md`): "Route profiles: running other Anthropic-compatible
   endpoints" section — create a dedicated Claude instance; sensitive env vars
   `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`; tier mapping `ANTHROPIC_MODEL`,
   `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
   `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` (endpoints that serve one
   model must map every tier or background fast-model calls 404); `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
   (muse: 1007997); `customModels` with the real slug; warning that built-in Claude model picks
   404 on such endpoints (measured). Concrete examples: Muse (`https://api.meta.ai`,
   `muse-spark-1.2-contributor`) and Kimi K3 (`https://api.kimi.com/coding`, `kimi-k3`) as
   "for example" endpoints, product voice, no aigate/warden references.
   Note: leave the broker fields empty on route-profile instances — broker injects OAuth which
   would fight the endpoint token.
3. `docs/internals/glossary.md`: "account hop", "route profile". `docs/internals/providers.md`:
   hop paragraph (trigger, park, teardown, no-auto-retry and why — cite T3 behavior).

## Verification gates

1. `grep -c aigate apps/server/src/provider/Layers/ClaudeAdapter.ts` → 0.
2. `cd apps/server && vp test run src/provider/Layers/ClaudeCredentialBroker.test.ts` → green
   (old 8 + new exclude/reportLimit/classifier cases).
3. `vp run --filter @t3tools/contracts typecheck && vp run --filter t3 typecheck` → rc 0 (run
   contracts build first if contracts changed).
4. Any touched files formatter-clean (`vp fmt <files>`).
5. Committed on `council/t3code-aigate-auth`, pushed to `fork`. No PR.

## Out of scope

Auto-retry of failed turns; hopping mid-turn; Codex/Cursor/Grok/OpenCode; aigate server changes;
mobile UI work beyond what contracts already render; repo-wide checks.
