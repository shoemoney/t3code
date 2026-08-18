# The Keychain war that wasn't

_2026-08-18 · Matrix Council: T3 Code × aigate_

We convened the council to plan something that sounded gnarly: make T3 Code — which spawns Claude
Code (and four other agent CLIs) as subprocesses — use aigate, our self-hosted credential vault on
.10, to pick the Claude account with the most headroom, hop accounts when one runs dry, and list
alt-endpoint models like Muse. The shell-level `ai` wrapper already does all of this, but it does
it with a machete: it **deletes the macOS Keychain login before every launch**, because a stored
login outranks the injected token and the claude binary rewrites the Keychain entry about a second
after every launch. Carrying that machete into a desktop app 100k people run was the design
problem everyone braced for.

## The wrong turn we came in holding

Round 1's dominant framing — mine included, it's in the brief — was that Keychain precedence was
the load-bearing unknown. Grok's seat put it best: _"until that experiment runs, every integration
sketch is fanfic."_ Two seats sketched mitigation machinery for it. One assumed the
Keychain-delete trick would have to come along.

The experiment took ninety seconds. Inject a deliberately bogus `CLAUDE_CODE_OAUTH_TOKEN` with a
fresh `CLAUDE_CONFIG_DIR`, keychain reads enabled:

```
Failed to authenticate. API Error: 401 OAuth access token is invalid.
```

That 401 is the whole ballgame. The env token was _used_ — the Keychain never rescued it. The
shadowing problem is a property of the **default config dir**, and T3 Code already isolates
`CLAUDE_CONFIG_DIR` per provider instance (it does this so two instances don't fight over one
login — the comment is right there in `ClaudeHome.ts`). The machete exists to solve a problem T3's
architecture already doesn't have. First probe was contaminated, for the record — `--bare` skips
keychain reads, which silently makes the test prove nothing. It failed the hard way, so it had to
go in again without it.

Five seats retracted nine claims on that and three other chair measurements. That's not the
council being wrong; that's the council working.

## What else died

**"aigate should list models."** aigate has no models endpoint. None. It's a key vault and an
account selector; Muse and Kimi routing live entirely in client-side env overlays
(`ANTHROPIC_BASE_URL=https://api.meta.ai`, tier-mapping vars, a 1M context cap the binary won't
guess). The council's unanimous reframe: Muse/Kimi are **T3-side route profiles**, and the only
real gap is that T3's model _picker_ doesn't know about pseudo-models yet — execution is a
pass-through, which we verified by reading `resolveClaudeApiModelId` (it appends a `[1m]` suffix
and otherwise touches nothing).

**"Rotation."** There is no rotation. `pickRanked` is one SQL statement: lowest worst-window
usage wins, TTL-parked accounts skipped. Best-headroom, not round-robin. Also no lease — two
hosts selecting simultaneously get the same account, healed by parking. Fine at session-start
granularity; a per-turn design would have piled every thread onto one account between polls.

**"Hopping is scary."** The scary version was built on a false premise — that the adapter spawns
per turn. It doesn't: one long-lived SDK `query()` per thread, with a resume cursor for
re-creation. So a hop is: park, re-select excluding the tried account, kill the query, recreate
with the resume cursor and the new token. Would the conversation survive an account change? We
planted a codeword under account A and resumed the session under account B's token:

```
TANGERINE
```

Transcripts live client-side. Anthropic doesn't pin a session to an account. n=1 and only at a
clean turn boundary — the mid-tool-call interrupt case is the named gate still standing in front
of Phase 2 — but the mechanism is real, and it's the same thing the shell warden's
`claude --continue` hop has been doing in production for weeks.

## The verdict

Opt-in generic credential broker, Claude-only, resolved at session start through the env seam T3
already has, under the config-dir isolation T3 already does. No Keychain manipulation. Hop and
route-profile models in Phase 2 behind two named tests. Codex explicitly out (the ChatGPT rung
died of a 402 on 2026-08-04 and nothing vaults Codex accounts). Fork-first, because upstream's
CONTRIBUTING.md says what it says; the one upstreamable slice is a ~small generic
"resolve-env-at-session-start" hook with zero aigate in it.

The plan with file-level touchpoints is in `council_meetings/t3code-aigate-auth/plan.md`. Phase 0
requires no code at all — three static instances and manual selection — which is the correct
Monday move while T1/T2 run.

Two rounds, nine retractions, eight experiments, one starved qwen (again — 12k tokens was not
enough, again). The framing everyone arrived with was killed by a ninety-second curl-and-401. The
council's cheapest member is still the one with a shell.
