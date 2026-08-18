# Operator & chair research — t3code-aigate-auth

## Chair experiments (run 2026-08-17, this Mac, claude binary at ~/.local/bin/claude)

### EXP-1: Does `CLAUDE_CODE_OAUTH_TOKEN` env beat the Keychain when `CLAUDE_CONFIG_DIR` is isolated? — YES (VERIFIED, n=1 box)

```
CLAUDE_CONFIG_DIR=<fresh dir> CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-BOGUS claude -p "say OK"
→ "Failed to authenticate. API Error: 401 OAuth access token is invalid."   # env token used; Keychain did NOT rescue

CLAUDE_CONFIG_DIR=<fresh dir> CLAUDE_CODE_OAUTH_TOKEN=<live aigate setup_token> claude -p "say OK"
→ "OK 👍"                                                                    # env token works end-to-end
```

Implication: the `aigate-run.sh` shadow-login problem (stored login outranks injected token;
binary rewrites Keychain ~1s after launch) is a property of the DEFAULT config dir. T3 Code
already sets a per-instance `CLAUDE_CONFIG_DIR` (`Drivers/ClaudeHome.ts:27-33`), so env-injected
account tokens are honored without touching the developer's real login. No Keychain clearing
needed, no fight with the `ai` CLI on the same box.

Caveats: one box, one binary version, headless `-p`. The SDK path (`query()`) forwards env the
same way but is UNTESTED specifically; `--bare` skips keychain reads and must not be used for
this probe (contaminated first attempt).

### EXP-2: Live aigate state (chair, curl)

- `GET /api/accounts`: 3 accounts — bastardtech 5h:8%/7d:58%, personal 38%/66%, shoemoney 0%/100% (weekly-maxed).
- `GET /api/select?host=<host>`: `{"account":"bastardtech","setup_token":"sk-ant-oat01…"}`.
- Endpoint `https://aigate.shoemoney.ai` (NPM → .10:20200).

## Operator findings (Haiku explorers, local file reading)

### aigate (../aigate)

- Full API map (see brief). Load-bearing: NO models endpoint, NO rotation state machine —
  `pickRanked` best-headroom selection + TTL parking (`/api/events/limit`, default 15m).
- `/api/capabilities` = read-only registry `{providers:{<p>:{keys,label,last_checked}}, claude:{selectable,accounts}}` — no secrets. Candidate for T3's "what can I route to" probe.
- `GET /api/keys/:provider` returns newest WORKING key `{provider,label,key,key_hint}`; 404 if none.
- Tokens AES-256-GCM at rest; setup tokens are long-lived, no refresh cycle; 401/403 on 10-min
  poll → `reauth_needed`, account leaves selection. Reset epochs stored from
  `anthropic-ratelimit-unified-{5h,7d}-reset` headers.
- Muse/Kimi are CLIENT-side alt-endpoint routes (env: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
  - tier-mapping + `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1007997`), not aigate server concepts.
- ChatGPT/Codex rung retired 2026-08-04 (out of credits); Codex rotation has no live backend today.

### T3 Code (this repo)

- Claude runs through `@anthropic-ai/claude-agent-sdk` `query()`; options built in
  `ClaudeAdapter.ts` (~:4154-4192) incl. `env` and `pathToClaudeCodeExecutable`.
- `mergeProviderInstanceEnvironment()` (`ProviderInstanceEnvironment.ts:3-16`, called
  `ClaudeDriver.ts:128`) overlays per-instance env vars; contract
  `ProviderInstanceEnvironmentVariable {name, value, sensitive}` with sensitive values in
  `~/.t3/userdata/secrets/*.bin` (`serverSettings.ts:316-376`, `ServerSecretStore`).
- Multi-instance per driver is native (`ProviderInstanceId`), e.g. two Codex instances.
- Static `CLAUDE_MODEL_CATALOG` (`ClaudeProvider.ts:65+`); `ModelSelection
{instanceId, model, options}` flows per-thread/turn (`ProviderService.ts:580-797`).
- Auth status probe extracts `init.account {email, subscriptionType, tokenSource, apiProvider}`
  (`ClaudeProvider.ts:732-975`).
- No rotation/broker prior art in the provider layer.

## Chair verification pass #2 (post-round-1, repo evidence)

- **EXP-3 — query lifecycle:** ONE long-lived SDK `query()` per thread: `createQuery(...)` at
  `ClaudeAdapter.ts:4221`, stored in `sessions: Map<ThreadId, ClaudeSessionContext>` (:4280),
  prompt is a streamed `AsyncIterable<SDKUserMessage>`. A resume-cursor mechanism exists
  (`readClaudeResumeState`, `resume: <uuid>`, `resumeSessionAt`) — a NEW query can resume a prior
  session id. VERIFIED. ⇒ Account hop mid-thread = kill query, re-create with `resume` cursor +
  new env. Turn-boundary only, same shape as `claude --continue`.
- **EXP-4 — env is captured at adapter construction, NOT per query:** `makeClaudeEnvironment` runs
  once in the adapter layer (:1663) and `queryOptions.env` reuses it (:4176). The fifth seat's
  CONTESTED claim is CONFIRMED: dynamic per-spawn env resolution requires new code (or an
  adapter/instance rebuild on settings change). `mergeProviderInstanceEnvironment` itself does NOT
  mutate `process.env` — it spreads into a new object (`ProviderInstanceEnvironment.ts:11`), so
  two instances with different tokens do not clobber each other. VERIFIED.
- **EXP-5 — rate-limit telemetry already flows:** the SDK emits `rate_limit_event`; the adapter
  maps it to `account.rate-limits.updated` orchestration events (`ClaudeAdapter.ts:3507-3552`).
  T3 natively knows per-account headroom during a session. VERIFIED. (This can drive park/hop
  decisions AND could POST to aigate `/api/events/usage`.)
- **EXP-6 — no server-side model catalog gate:** `resolveClaudeApiModelId`
  (`ClaudeProvider.ts:464-471`) is a pass-through (appends `[1m]` for 1m-context option). A
  pseudo-model slug (e.g. `muse-spark-1.2-contributor`) reaches the SDK untouched. The catalog
  gates the client picker/UI, not execution. VERIFIED.
- **EXP-7 — aigate `/api/select` has NO lease/transaction:** `pickRanked` is a plain ranked SELECT
  (`src/server.js:295-298`); concurrent cross-host callers can receive the same account; healing
  is TTL parking + 10-min usage polling. VERIFIED. (Fine for coarse balancing; per-turn
  hammering from many T3 threads would pile onto one account until the next poll.)
- **EXP-1 addendum:** the CLI probe used the same binary the SDK spawns
  (`pathToClaudeCodeExecutable` → cli). Same-code-path argument makes Keychain-bypass-under-
  isolation VERIFIED for practical purposes on macOS; Linux (`.credentials.json` under
  CLAUDE_CONFIG_DIR) follows the same isolation by construction. Remaining risk: future binary
  versions changing precedence — trivially re-testable with the EXP-1 bogus-token probe.
- **Scope fact:** ChatGPT/Codex rotation has no live backend (aigate gpt rung retired 2026-08-04,
  402 out-of-credits). Codex auth is its own OAuth in `~/.codex/auth.json`; nothing in aigate
  vaults Codex accounts today.

## Chair verification pass #3 (post-round-2)

- **EXP-8 — cross-account session resume: VERIFIED.** Session minted under account A
  (bastardtech), `claude -p --resume <sid>` under account B's token (personal), same isolated
  CLAUDE_CONFIG_DIR: the codeword planted under A came back verbatim under B ("TANGERINE").
  Transcript lives client-side under CLAUDE_CONFIG_DIR; Anthropic does not pin a session to an
  account. n=1, clean turn boundary, haiku model. Mid-tool-call interruption + hop remains
  untested (named open item).

## Chair verification pass #4 (implementation night — EXP-9, the probe that caught a shim)

The T4 regression probe's first honest run (post env-stripping hardening) FAILED: bogus
CLAUDE_CODE_OAUTH_TOKEN + fresh CLAUDE_CONFIG_DIR SUCCEEDED, apparently falsifying EXP-1.
Bisect matrix (9 further runs): inline calls pinned to ~/.local/bin/claude 401'd 100% of the
time; the script reproduced its success 100% of the time. Deterministic difference found:
`command -v claude` in the script's bash resolved to a **cmux CLI shim**
(/var/folders/.../cmux-cli-shims/<uuid>/claude) that wraps claude and injects its own working
credentials.

- **EXP-1 STANDS**: with the real binary, env token honored under isolated config dir, 9/9.
- **New VERIFIED hazard**: PATH shims from agent runners inject credentials and silently
  override brokered injection. Applies to anything resolving `claude` via PATH — including a
  T3 instance whose binaryPath is bare "claude" while the server's PATH carries a shim dir.
- Probe hardened: prints the resolved binary, hard-FAILs on shim-looking paths (temp dirs),
  takes CLAUDE_BIN to pin. On boxes with no stored login (this one — the warden clears it),
  the control correctly SKIPs.
- Meta-lesson (again): the first "falsification" was a wrong-probe artifact; the second look
  found a REAL adjacent hazard. Both outcomes only surfaced because the probe existed.

## Chair verification pass #5 (Phase 2 gates, 2026-08-18 morning)

- **T1 (VERIFIED):** Meta gateway 404s claude slugs (`not_found_error`), serves
  `muse-spark-1.2-contributor` → route profiles must expose real slugs via customModels.
- **T2 (VERIFIED):** SDK `initializationResult().account` under injected token =
  `{tokenSource:"CLAUDE_CODE_OAUTH_TOKEN", apiProvider:"firstParty"}` — typed proof of the
  credential source (no email in this shape; broker resolution carries the account name).
- **T3 (VERIFIED, with teeth):** mid-tool-call interrupt under account A → resume under B:
  session + context carry over, task completes — but the resumed model RE-EXECUTED an
  already-completed Write (wrote one.txt twice) despite explicit "don't redo" instructions.
  Auto-retry after interrupt = duplicated side effects with non-idempotent tools. v1 hop must
  not auto-retry. (bastardtech → personal, haiku, n=1.)
- **EXP-10 (VERIFIED):** full muse route profile through the Agent SDK `query()` — env overlay
  (BASE_URL/AUTH_TOKEN/tier map/CLAUDE_CODE_MAX_CONTEXT_TOKENS) + explicit
  `model: muse-spark-1.2-contributor` → success, `modelUsage` names muse as the serving model.
