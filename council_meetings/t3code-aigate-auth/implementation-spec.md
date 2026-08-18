# Phase 1 implementation spec — generic credential broker (Claude driver)

Verdict + constraints: see plan.md in this directory. This spec is the file-level design.
Repo doctrine: AGENTS.md at repo root. Effect code: read `.repos/effect-smol/LLMS.md` first.

## Shape

Opt-in per-instance broker. At **session start** (query construction in ClaudeAdapter), if the
instance has a broker URL configured, call `GET {url}/api/select?host={hostname}` with
`Authorization: Bearer {token}` (token read from the instance environment, so it lives in the
sensitive secret store), and overlay the returned credentials onto the captured env for THIS
query only. Failure = loud log + fall back to the instance's own env. No retries beyond the one
call, no Keychain code, no aigate identifiers in ClaudeAdapter.ts (generic "credential broker"
naming only).

## 1. Contracts — `packages/contracts/src/settings.ts`

Add to `ClaudeSettings` (:360, follow the existing field style exactly):

- `brokerUrl`: TrimmedString, decoding default `""`, annotateKey title "Credential broker URL",
  description "Optional. Account-selector endpoint called at session start to pick credentials
  for this instance (aigate-compatible: GET /api/select). Empty disables brokering.",
  providerSettingsForm placeholder `https://broker.example.com`, clearWhenEmpty "omit".
- `brokerTokenEnv`: TrimmedString, decoding default `""`, title "Credential broker token variable",
  description "Name of an environment variable on this instance holding the broker bearer token.
  Add the token as a sensitive environment variable. Defaults to AIGATE_TOKEN.",
  placeholder `AIGATE_TOKEN`, clearWhenEmpty "omit".

Update the `order` array (append after `launchArgs`) and `ClaudeSettingsPatch` (:729) with both
fields as `Schema.optionalKey(TrimmedString)`. Touch NOTHING else in the file. Then run
`vp run --filter @t3tools/contracts build` so dependents typecheck.

## 2. Broker module — `apps/server/src/provider/Layers/ClaudeCredentialBroker.ts` (new)

Small, dependency-free (global `fetch`, `AbortSignal.timeout(8000)`), Effect-wrapped:

```ts
export type BrokerResolution =
  | { _tag: "ok"; account: string; env: Record<string, string> }
  | { _tag: "disabled" }
  | { _tag: "unreachable"; detail: string }
  | { _tag: "unauthorized" }
  | { _tag: "no-headroom"; accounts?: number };

export const resolveBrokerEnvironment: (input: {
  brokerUrl: string; // trimmed; "" => disabled
  token: string | undefined; // from env[brokerTokenEnv || "AIGATE_TOKEN"]
  host: string; // os.hostname()
}) => Effect.Effect<BrokerResolution>; // never fails — errors become tags
```

Classification (mirrors the proven warden diagnostics — see plan.md "Operational cautions"):
network error/timeout → `unreachable`; HTTP 401 → `unauthorized`; 2xx JSON with `setup_token`
→ `ok` with env `{ CLAUDE_CODE_OAUTH_TOKEN: setup_token, AIGATE_ACCOUNT: account }`; JSON
without `setup_token` but with an `accounts` field → `no-headroom`; anything else →
`unreachable` with the body snippet as detail. Missing token when brokerUrl set → `unauthorized`.
Never log the token or the returned setup_token. Export a pure
`applyBrokerResolution(baseEnv, resolution)` that returns `{...baseEnv, ...resolution.env}` for
`ok` and `baseEnv` otherwise (unit-testable without IO).

## 3. Adapter seam — `apps/server/src/provider/Layers/ClaudeAdapter.ts`

At query construction (the function building `queryOptions` around :4154; `claudeSettings` and
`claudeEnvironment` are in closure scope):

- Before building `queryOptions`: if `claudeSettings.brokerUrl` (trimmed) is non-empty, resolve:
  token = `claudeEnvironment[claudeSettings.brokerTokenEnv || "AIGATE_TOKEN"]`, host =
  `NodeOS.hostname()`. `const brokerResolution = yield* resolveBrokerEnvironment(...)`.
- `env: applyBrokerResolution(claudeEnvironment, brokerResolution)` (or `claudeEnvironment`
  unchanged when disabled).
- Loud fallback: on any non-ok non-disabled tag, `yield* Effect.logWarning(...)` naming the tag
  and instance, e.g. "credential broker unreachable — session uses instance credentials".
- Span annotations next to the existing `claude.query.*` block: `claude.broker.status` (the tag)
  and `claude.broker.account` ("" unless ok). Never annotate the token.
- Import ONLY from `./ClaudeCredentialBroker.ts`. The string "aigate" must not appear in
  ClaudeAdapter.ts (env var NAME `AIGATE_TOKEN`/`AIGATE_ACCOUNT` lives in the broker module as
  the protocol default).

## 4. Tests — `apps/server/src/provider/Layers/ClaudeCredentialBroker.test.ts` (new)

Follow the package's existing test conventions (find a sibling `*.test.ts` in apps/server and
copy its harness/imports style; run with `cd apps/server && vp test run src/provider/Layers/ClaudeCredentialBroker.test.ts`).
Stub server: `node:http` on port 0. Cases: (1) ok select → env has CLAUDE_CODE_OAUTH_TOKEN +
AIGATE_ACCOUNT; (2) 401 → unauthorized; (3) no-headroom JSON (`{"accounts":3,"parked":1}`) →
no-headroom; (4) connection refused (closed port) → unreachable; (5) empty brokerUrl → disabled;
(6) missing token → unauthorized without any HTTP call; (7) `applyBrokerResolution` overlay and
passthrough. No sleeps — await real server lifecycle events.

## 5. Regression probe — `scripts/claude-auth-precedence-probe.sh` (new, executable)

EXP-1 as a script (plan.md test T4): fresh temp CLAUDE_CONFIG_DIR, `CLAUDE_CODE_OAUTH_TOKEN`
set to an obviously bogus value, run `claude -p "say OK" --model claude-haiku-4-5-20251001`;
PASS (exit 0) iff output contains a 401/invalid-token auth failure; FAIL loudly if the call
SUCCEEDS (means a stored login shadowed the env token and broker injection is unsafe on this
binary). Header comment explains why. Takes optional CLAUDE_BIN env override.

## 6. Docs

- `docs/user/`: add a short "Credential broker" section in the most fitting existing user doc
  (or a new `docs/user/credential-broker.md` if none fits): what it does, the two settings
  fields, the sensitive-env-var token step, shipped-product voice, no repo paths, no "aigate"
  branding beyond "aigate-compatible selector endpoint (GET /api/select)".
- `docs/internals/providers.md`: one paragraph on the session-start resolution seam and the
  fallback semantics.
- `docs/internals/glossary.md`: entry "credential broker" following the file's format.

## Verification gates (from the /goal)

1. `grep -rn "aigate" apps/server/src/provider/Layers/ClaudeAdapter.ts` → 0 hits.
2. `cd apps/server && vp test run src/provider/Layers/ClaudeCredentialBroker.test.ts` → exit 0.
3. `vp run --filter @t3tools/contracts typecheck && vp run --filter t3 typecheck` → exit 0.
4. Probe script exists + is executable.
5. Committed on `council/t3code-aigate-auth`, pushed to `fork`.

## Out of scope (hard)

No account hopping, no muse/kimi route profiles, no model-catalog changes, no other drivers, no
Keychain/credential-file logic, no ~/.t3 access, no repo-wide checks, no PR.
