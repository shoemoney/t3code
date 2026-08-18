# Council Brief: T3 Code × aigate — account brokering for embedded Claude Code (and friends)

## The question

T3 Code (this repo, `/Users/shoemoney/Projects/shoecoder`) spawns provider CLIs (Claude Code,
Codex, Cursor, Grok, OpenCode) as subprocesses. Today each CLI uses whatever single login lives on
the box. The owner runs **aigate** (`/Users/shoemoney/Projects/aigate`, deployed on TrueNAS .10 at
`https://aigate.shoemoney.ai`) — a credential vault + **Claude account selector** that already
rotates three Claude Max accounts for the shell-level `ai` wrapper.

**Design the integration plan:** how should T3 Code use aigate for (a) provider authentication —
picking the Claude account with the most headroom per turn/session, reporting limits back, hopping
accounts when one runs dry — and (b) model listing, including non-Anthropic models that ride the
official claude binary (Muse via `api.meta.ai`, Kimi K3), similar to what `ai` / `aigate-run.sh`
does today, but as a first-class T3 Code feature rather than a shell wrapper?

Constraints from the repo's own doctrine (AGENTS.md): open-source project with 100k+ users and many
forks — the integration must be **optional and generic** (not hardcoded to shoemoney's LAN),
performance-conscious, remote-ready, and must hit all surfaces (web/desktop/mobile, all providers
get an explicit decision, contracts in `packages/contracts`, reverse states, docs). Upstream
maintainers (Theo/Julius) accept only small focused PRs — so the plan must decide: fork-feature,
upstreamable feature, or external shim.

## Measured facts (chair-verified, 2026-08-17)

### aigate is live and holds real accounts

```
$ curl -H "Authorization: Bearer $AIGATE_TOKEN" https://aigate.shoemoney.ai/api/accounts
3 accounts: bastardtech 5h:8% 7d:58% | personal 5h:38% 7d:66% | shoemoney 5h:0% 7d:100% (weekly-maxed)

$ curl .../api/select?host=<host>
{"account":"bastardtech","setup_token":"sk-ant-oat01…"}
```

- aigate is **NOT a proxy** (README, COMPLIANCE.md): it never sits in Anthropic's request path. It
  _picks_ the account/key and records usage. Compliance posture: official binary, own accounts, no
  relay, no forged headers.
- Client auth to aigate: `Authorization: Bearer $AIGATE_TOKEN`; env at `~/.claude/aigate/env`
  (`AIGATE_URL`, `AIGATE_TOKEN`).

### The existing warden mechanism (`~/.claude/aigate/aigate-run.sh`, invoked by `ai`)

Verified by reading the script:

- **Select:** `GET /api/select?host=$HOST&exclude=<tried,accounts>` → `{account, setup_token}`.
- **Inject:** `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL`;
  `export CLAUDE_CODE_OAUTH_TOKEN=<setup_token> AIGATE_ACCOUNT=<name>`.
- **Shadow-login clear:** on macOS the claude binary rewrites the Keychain entry
  (`Claude Code-credentials`) ~1s after every launch and a stored login OUTRANKS the injected
  token — so the warden deletes the Keychain entry before each run (Linux: rm
  `~/.claude/.credentials.json`).
- **Headless (-p) retry loop:** up to 3 attempts; classifies output — 529/overloaded = global load
  shed, retry SAME account after 10s (don't drain the pool); `rate limit|usage limit|429|quota|…` =
  park via `POST /api/events/limit` and re-select with `exclude=`.
- **Interactive supervision:** run the binary un-exec'd; on exit check cached usage
  (`GET /api/accounts`), if worst ≥85% do a live `POST /api/accounts/<a>/refresh`; if maxed, park,
  re-select, and relaunch `claude --continue` — **same conversation carries over on the next
  account**.
- **Telemetry:** `POST /api/events/prompt` (account, host, prompt[:400]) on every launch.
- **Fallback chain:** all Claude accounts dry → Kimi K3 (official binary against Kimi's
  Anthropic-compatible endpoint, key from vault `GET /api/keys/kimi`) → Meta Muse.
- **Stale-config guard:** warns if `ANTHROPIC_BASE_URL` lurks in `~/.claude/settings*.json`
  (silently hijacks every request).

### Muse inside the official claude binary (`aigate-muse.sh`)

- Meta's gateway is dual-protocol; speaks Anthropic `/v1/messages` natively, Bearer-only.
- `ANTHROPIC_BASE_URL=https://api.meta.ai`, `ANTHROPIC_AUTH_TOKEN=<LLM|key>` (from
  `~/.config/muse/auth.json` → vault `GET /api/keys/muse` → local cache).
- Model `muse-spark-1.2-contributor` mapped onto EVERY tier env
  (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`)
  because no fast tier is served — an unmapped background haiku call 404s.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1007997` — without it Claude Code assumes 200k for unknown
  models and auto-compacts 5× too early.
- Tool-name 64-char limit enforced strictly by Meta's gateway → one plugin with 73-char tool names
  is disabled via a dedicated `--settings` file for muse sessions.
- `CLAUDE_CODE_OAUTH_TOKEN` must be UNSET for muse/kimi routes (and ANTHROPIC\_\* unset for OAuth
  routes) — the two auth families fight.

### aigate server internals (Operator-researched, chair spot-checked)

- **No model-listing endpoint exists.** aigate stores provider _keys_ (65-provider catalog in
  `src/providers.js`), never enumerates models, and never filters by model. "List models such as
  muse" therefore cannot be served by aigate today — it's either a new aigate endpoint or T3-side
  knowledge.
- **No "plan"/rotation command exists.** Selection is `pickRanked` (`src/server.js:295–298`):
  lowest `max(five_hour_pct, seven_day_pct)` wins among eligible (not disabled, not reauth-needed,
  not parked, under cutoff). Parking is TTL-based via `POST /api/events/limit` (default 15m,
  1–360m). Best-headroom, not round-robin.
- Full API: `/api/select`, `/api/accounts` (+ per-account refresh/disable/rename), `/api/keys/:provider`
  (newest _working_ key, decrypt-before-audit), `/api/events/{limit,usage,prompt}`,
  `/api/capabilities` (read-only registry: providers with key counts + claude account/selectable
  counts — NO secrets), `/api/logs`, `/api/access`, `/api/stats`, `/api/metrics` (Prometheus),
  `/ws` (live feed, bearer in `Sec-WebSocket-Protocol: bearer.<token>`), `/health` (unauth).
- Tokens: `claude setup-token` output (`sk-ant-oat01-…`), AES-256-GCM at rest
  (`accounts.token_enc`), long-lived (no refresh cycle). 401/403 on the 10-min poll sets
  `reauth_needed` and the account drops out of selection. Poller also stores
  `anthropic-ratelimit-unified-{5h,7d}-reset` epochs.
- Deployment: docker-compose on .10, port 20200 (`http://192.168.1.10:20200`,
  `https://aigate.shoemoney.ai` via NPM). `AIGATE_ALLOW_CIDR` network gate available.

### T3 Code architecture (Operator-researched, chair spot-checked in repo)

- Server: event-sourced; clients → typed WS requests → commands → decider → events → projector.
  Contracts in `packages/contracts`. Secrets/settings under `~/.t3/userdata`.
- **Claude runs via `@anthropic-ai/claude-agent-sdk` `query()`** — not the interactive CLI.
  `apps/server/src/provider/Layers/ClaudeAdapter.ts` builds query options (cwd, model,
  `pathToClaudeCodeExecutable`, `env`, permissionMode, settings) around line 4154-4192.
- **Env injection point exists and is chair-verified:**
  `mergeProviderInstanceEnvironment()` (`apps/server/src/provider/ProviderInstanceEnvironment.ts:3-16`)
  overlays per-instance `ProviderInstanceEnvironment` variables onto `process.env`; called in
  `Drivers/ClaudeDriver.ts:128`. Contract type `ProviderInstanceEnvironmentVariable`
  (`packages/contracts/src/providerInstance.ts:104-113`) has a `sensitive` flag; sensitive values
  are stored in `~/.t3/userdata/secrets/*.bin` via `ServerSecretStore` and re-materialized on read
  (`serverSettings.ts:316-376`). A test already exercises `ANTHROPIC_API_KEY` through this path.
- **Per-instance config isolation:** `Drivers/ClaudeHome.ts:27-33` sets `CLAUDE_CONFIG_DIR` to an
  instance-specific home (comment notes OAuth credential / "Not logged in" pitfalls).
- **Multi-instance is native:** multiple provider instances of the same driver coexist
  (e.g. `codex_personal` + `codex_work`), each with its own env, keyed by `ProviderInstanceId`.
  This is the repo's existing shape for "multiple accounts".
- **Model catalog is static:** `CLAUDE_MODEL_CATALOG`
  (`Layers/ClaudeProvider.ts:65+`, chair-verified: `claude-fable-5` at :67,
  `CURRENT_CLAUDE_MODELS` at :59). Model selection flows per-thread/turn through
  `ProviderService.startSession/sendTurn` (`:580-797`) as a `ModelSelection`
  `{instanceId, model, options}` and maps to an API model id passed to the SDK.
- **Auth detection:** `checkClaudeProviderStatus()` / `probeClaudeCapabilities()`
  (`Layers/ClaudeProvider.ts:732-975`) spawn a probe query and read
  `init.account {email, subscriptionType, tokenSource, apiProvider}`.
- **No existing rotation/broker prior art** in the provider layer (only APNS JWT rotation in
  relay infra, unrelated).

### Cross-cutting hazard (chair-flagged)

`aigate-run.sh` documents (operationally, on macOS): _a stored Claude login OUTRANKS the injected
`CLAUDE_CODE_OAUTH_TOKEN`, and the claude binary rewrites the Keychain entry ~1s after launch._
Whether this shadowing applies to the Agent SDK path T3 uses (with per-instance
`CLAUDE_CONFIG_DIR`) is UNMEASURED and load-bearing: if a Keychain login wins over env injection,
per-turn account selection silently runs the wrong account. This needs a named experiment.

## Explicitly unknown / to be settled

1. **Where the broker hook belongs**: env-injection at adapter spawn vs a first-class "credential
   broker" concept in server config vs an external wrapper binary (point T3's claude path at a
   shim like `aigate-run.sh`) with zero T3 code changes.
2. **Session vs turn granularity**: aigate hops accounts between _processes_; T3 threads are
   long-lived with `--continue`-like resume semantics via the adapter protocol (stream-json?).
   Does mid-thread account hop work under T3's session management, and who detects "out of
   headroom"?
3. **Model listing**: aigate has NO models endpoint — so "list models such as muse" means either
   (a) T3-side static/config knowledge of alt-endpoint routes (muse/kimi as pseudo-models of the
   claude provider, env-injected like `aigate-muse.sh` does), or (b) a new aigate
   `/api/models`-style endpoint derived from vaulted providers, or (c) reusing
   `/api/capabilities`. Which, and what contract change across web/desktop/mobile?
4. **Multi-machine**: T3 servers run on several boxes (fleet). aigate already arbitrates
   cross-host. Any per-host state (keychain clearing!) that breaks when T3 desktop and `ai` CLI
   share a box?
5. **Keychain clobbering conflict**: aigate's `clear_shadow_login` deletes the developer's real
   Claude login. If T3 Code (e.g. the desktop app on the same Mac) relies on the stored login for
   its embedded Claude Code, the two mechanisms actively fight. Who wins, and how do we make them
   coexist?
6. **Upstream posture**: fork vs upstream PR vs zero-diff shim. CONTRIBUTING.md: "not actively
   accepting contributions"; big features will be closed.
7. **Codex/ChatGPT plans**: the gpt rung is retired (aigate-gpt.sh 402s, "workspace is out of
   credits", retired 2026-08-04) — is Codex account rotation in scope at all, or Claude-only for
   v1?

## Success criteria for the plan

- Concrete, ordered implementation plan with file-level touchpoints in this repo.
- Every claim labelled; theories carry their falsifying test.
- Explicit decision per provider adapter (Claude, Codex, Cursor, Grok, OpenCode) even if "not
  supported".
- A Monday-morning smallest-shippable step.
