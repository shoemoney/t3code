# Plan: T3 Code × aigate — brokered Claude accounts + route-profile models

**Council verdict (2026-08-18, converged in substance after 2 rounds + 8 chair experiments).**
Status labels per claim; anything driving code below is VERIFIED unless marked.

## The verdict in one paragraph

Integrate aigate as an **opt-in, generic credential broker** for the Claude provider only,
resolved at **session start** (the verified attachment point — one long-lived SDK `query()` per
thread), injecting `CLAUDE_CODE_OAUTH_TOKEN` through T3's existing per-instance env seam under
per-instance `CLAUDE_CONFIG_DIR` isolation — **no Keychain touching, ever** (EXP-1: isolation
makes the env token win). Account hopping is Phase 2, turn-boundary only, via kill-query →
re-select → recreate-with-resume-cursor (EXP-3 + EXP-8: cross-account resume carries the
conversation). Muse/Kimi are **T3-side route profiles** (env overlays), never an aigate models
endpoint (aigate has none). Codex/Cursor/Grok/OpenCode: explicitly not supported in v1.
Fork-first; one small generic hook is the only upstream PR candidate.

## Phase 0 — today, zero code changes

Static multi-account via T3's native multi-instance:

1. Create Claude provider instances `claude-bastardtech`, `claude-personal`, … each with
   `CLAUDE_CODE_OAUTH_TOKEN` as a **sensitive** `ProviderInstanceEnvironment` variable (value =
   that account's `claude setup-token`, fetchable from aigate's vault). T3 stores it encrypted in
   `~/.t3/userdata/secrets/`, isolates config via per-instance `CLAUDE_CONFIG_DIR`, and the
   status probe will show each instance's account email/subscription.
2. The user picks the account by picking the instance in the model picker. Manual "rotation".

Ceiling: tokens are duplicated into T3's store (rotate by re-pasting), no headroom awareness.
This is the fallback posture whenever the broker is off or unreachable.

## Phase 1 — brokered selection at session start (fork feature, small)

**Contract** (`packages/contracts/src/providerInstance.ts` or a new `credentialBroker.ts`):

```ts
// on the Claude driver's config (ClaudeSettings)
credentialBroker?: {
  kind: "aigate",            // discriminated union; only member for now
  url: string,               // e.g. https://aigate.shoemoney.ai
  tokenEnvName?: string,     // bearer stored as a sensitive instance env var
  reportUsage?: boolean,     // POST /api/events/usage from rate-limit telemetry
}
```

Generic posture: the server-side seam is "resolve extra env at session start"; the aigate client
is one small module behind it. No aigate constants in core, off by default, forks can add other
brokers.

**Server** (`apps/server/src/provider/`):

- New `Layers/ClaudeCredentialBroker.ts` (~100 lines): `GET {url}/api/select?host={hostname}` with
  `Authorization: Bearer`, 8s timeout → `{account, setup_token}` →
  `{CLAUDE_CODE_OAUTH_TOKEN, AIGATE_ACCOUNT}`. Errors: fail LOUD into provider status
  ("broker unreachable — using instance credentials"), then fall back to Phase-0 static env.
  Distinguish unreachable / 401 / genuine no-headroom (the `accounts` field), exactly as
  `aigate-run.sh:no_token_diag` does.
- `Layers/ClaudeAdapter.ts`: env is currently frozen at adapter construction
  (`makeClaudeEnvironment` :1663, reused in queryOptions :4176 — EXP-4). Move/augment resolution
  to **query construction** (:4221): `env = broker ? {...claudeEnvironment, ...await resolve()}
: claudeEnvironment`. This is the one real structural change.
- `Layers/ClaudeProvider.ts`: status/capabilities probe already extracts
  `init.account {email, subscriptionType}` — surface "via aigate: <account>" per session so the
  UI never lies about which account is running.
- Telemetry (cheap, optional): the adapter already maps SDK `rate_limit_event` →
  `account.rate-limits.updated` (:3507-3552). When `reportUsage`, POST the percentages to
  `/api/events/usage` — this tightens aigate's 10-min poll loop for everyone.

**Clients:** Settings → provider instance form gets the broker fields (web first; desktop wraps
web; mobile reads the same contract — render account name in the thread header where the model
label already lives). Reverse state: broker off → instance behaves exactly as Phase 0.

**Docs:** `docs/user/` (feature, shipped-product voice), `docs/internals/providers.md` (seam),
`docs/internals/glossary.md` ("credential broker").

**Tests:** unit-test the broker client against a stub server (select / 401 / unreachable /
no-headroom); adapter test that session-start env resolution overlays correctly. The EXP-1
bogus-token probe becomes a regression test script (guards against a future binary changing
credential precedence).

## Phase 2 — turn-boundary account hop + route-profile models

**Hop (Claude only):**

- Trigger: typed rate-limit exhaustion (from `account.rate-limits.updated` / SDK error), never
  regex-scraping output.
- Mechanics (all verified): `POST /api/events/limit {account}` to park → re-select with
  `exclude=<tried>` → kill the thread's query → recreate via the existing resume cursor
  (`readClaudeResumeState`, `resume: <uuid>`) with the new token in env. EXP-8 proved the
  conversation carries across accounts (transcript is client-side; Anthropic doesn't pin).
- 529/overloaded = global load-shed: retry same account after backoff, don't park (drains the
  pool) — port the warden's classifier distinction.
- Reverse states in the UI: `selecting → active(account) → parked → hopped(account')`, and the
  user can pin an account (hop off) per thread.

**Route profiles (muse/kimi as first-class models):**

- Per-instance env overlay is already enough for auth/routing
  (`ANTHROPIC_BASE_URL=https://api.meta.ai`, `ANTHROPIC_AUTH_TOKEN=<LLM| key>`, tier-mapping
  vars, `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1007997`). Keys fetchable once from aigate's vault
  (`GET /api/keys/muse`) into a sensitive instance var.
- Gap (named test T1 below): the SDK passes an explicit `model:` option which likely overrides
  the tier-mapping envs, and the picker only lists `CLAUDE_MODEL_CATALOG`. Fix: per-instance
  `additionalModels` in the Claude driver config feeding the provider's model list (catalog gates
  the picker only — execution is pass-through, EXP-6), so a muse instance lists
  `muse-spark-1.2-contributor` with its real 1M context window.

## Explicit per-provider decisions (required by AGENTS.md)

| Provider | v1 decision           | Why                                                                                                  |
| -------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude   | Brokered (Phases 0–2) | aigate's entire selection model is Claude setup tokens                                               |
| Codex    | **Not supported**     | ChatGPT rung retired 2026-08-04 (402); aigate vaults no Codex accounts. Revisit only if that changes |
| Cursor   | Not supported         | No aigate concept for it                                                                             |
| Grok     | Not supported         | Same                                                                                                 |
| OpenCode | Not supported         | Same; can consume vaulted API keys via Phase-0 static env if ever wanted                             |

## Upstream posture

Fork-first on `shoemoney/t3code`. The only upstreamable slice: the generic
"resolve-env-at-session-start" hook + `credentialBroker` contract stub (small, no aigate code,
one concern). Offer it as a Discussion first per CONTRIBUTING.md; expect no.

## Operational cautions (from evidence)

- `/api/select` has **no lease** (EXP-7): select per session start, not per turn; many
  simultaneous session starts can briefly pile onto one account until parking/usage events land.
  Acceptable at fleet scale of ~3 accounts; `reportUsage` shortens the window.
- Never run the aigate shell warden's `clear_shadow_login` on a box where T3 desktop runs — T3
  doesn't need it (isolation wins), and deleting the Keychain login would break the developer's
  own interactive `claude`. The two coexist precisely because T3 never touches shared state.
- Setup tokens are long-lived with no refresh: broker 401 → surface "re-auth needed on aigate"
  in provider status, don't retry-loop.

## Still open — named experiments

- **T1:** muse/kimi instance with explicit SDK `model:` option — does the alt-endpoint reject
  claude slugs (expected 404) and accept `muse-spark-1.2-contributor`? Settles the
  `additionalModels` design.
- **T2:** `probeClaudeCapabilities` under an injected token — confirm `init.account.email`
  reflects the brokered account (expected yes; cheap).
- **T3:** hop after a mid-tool-call interrupt (EXP-8 was a clean turn boundary): interrupt a
  streamed turn, resume under account B, verify no duplicated side effects.
- **T4 (regression):** EXP-1 bogus-token probe pinned in CI against new claude binary versions.

## Monday morning (smallest shippable)

1. Phase 0: add two static instances (bastardtech, personal) + one muse route-profile instance
   in your own T3; live with it for a week.
2. Run T1 and T2 (an evening).
3. Then build Phase 1 on the fork.
