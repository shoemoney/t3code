# Claude

This guide is for people who want to use more than one Claude setup in T3 Code. For Codex, see
[Codex](./providers-codex.md). For first-time setup, see [Install T3 Code](./install.md).

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In T3 Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

An empty `CLAUDE_CONFIG_DIR path` means T3 Code uses Claude Code's normal config directory.

When you set this field, T3 Code points Claude Code at that directory with the
`CLAUDE_CONFIG_DIR` environment variable. It does not change `HOME`, so your system keychain and
the rest of your environment stay as they are.

## Where Claude Skills Are Loaded

T3 Code looks for Claude skills in the Claude config directory's `skills` folder, then
`<workspace>/.agents/skills`, then `<workspace>/.claude/skills`.

If the same skill name exists in more than one folder, the later folder wins.

## I Want Work And Personal Claude Accounts

Use a different Claude config directory for each account.

Example:

```text
default config dir           work account
~/.claude_personal_home      personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In T3 Code Settings:

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### Set Up The Second Account

Log in with a separate config directory:

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login
```

Use `CLAUDE_CONFIG_DIR`, not `HOME`. Setting `HOME` writes the login to
`~/.claude_personal_home/.claude`, which is not where T3 Code looks.

Then add another Claude provider in T3 Code:

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

T3 Code only offers Claude providers that use the same config directory for an existing thread. A
different config directory is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its config directory, so T3 Code keeps separate config directories isolated
instead of trying to share part of the state.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in T3 Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. T3 Code stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

T3 Code does not need a special Claude Code Router provider. Treat the router as a Claude
environment: give a Claude provider its own `CLAUDE_CONFIG_DIR path`, and put whatever variables
the router tells you to export into that provider's Environment variables section. Mark tokens
and API keys as sensitive.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_router_home
```

Follow the upstream project's README for the router's own install, startup, and configuration
steps: <https://github.com/musistudio/claude-code-router>.

## Route Profiles: Running Other Anthropic-Compatible Endpoints

A route profile is a dedicated Claude provider instance pointed at a different
Anthropic-compatible endpoint instead of `api.anthropic.com` — for example, a proxy that fronts a
non-Anthropic model behind the Claude Code protocol.

### Configure A Route Profile

Create a new Claude provider instance for the endpoint:

```text
Display name: Claude Muse
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_muse_home
```

In that provider's Environment variables section, add the endpoint and its token:

```text
ANTHROPIC_BASE_URL    https://your-endpoint.example.com
ANTHROPIC_AUTH_TOKEN  <endpoint token>                    Sensitive
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive.

### Map Every Model Tier

If the endpoint serves a single model, map all of Claude Code's model roles to it. An endpoint
that only maps some roles will 404 on the roles you left out, including background fast-model
calls:

```text
ANTHROPIC_MODEL                     <endpoint model slug>
ANTHROPIC_DEFAULT_OPUS_MODEL        <endpoint model slug>
ANTHROPIC_DEFAULT_SONNET_MODEL      <endpoint model slug>
ANTHROPIC_DEFAULT_HAIKU_MODEL       <endpoint model slug>
ANTHROPIC_SMALL_FAST_MODEL          <endpoint model slug>
```

If the endpoint supports a larger context window than Claude's default, raise it too:

```text
CLAUDE_CODE_MAX_CONTEXT_TOKENS      1007997
```

### Add The Model To The Picker

Built-in Claude model picks (Sonnet, Opus, Haiku) will 404 against a route-profile endpoint —
those slugs don't exist there. Add the endpoint's real model slug as a custom model instead: open
this provider instance's card in Settings → Providers, expand its Models section, and add the
slug. It appears in the model picker for this instance alongside (or instead of) the built-ins.

### Example: Muse

```text
ANTHROPIC_BASE_URL              https://api.meta.ai
ANTHROPIC_AUTH_TOKEN             <token>                  Sensitive
ANTHROPIC_MODEL                  muse-spark-1.2-contributor
ANTHROPIC_DEFAULT_OPUS_MODEL     muse-spark-1.2-contributor
ANTHROPIC_DEFAULT_SONNET_MODEL   muse-spark-1.2-contributor
ANTHROPIC_DEFAULT_HAIKU_MODEL    muse-spark-1.2-contributor
ANTHROPIC_SMALL_FAST_MODEL       muse-spark-1.2-contributor
CLAUDE_CODE_MAX_CONTEXT_TOKENS   1007997
```

Add `muse-spark-1.2-contributor` as a custom model on this instance.

### Example: Kimi K3

```text
ANTHROPIC_BASE_URL              https://api.kimi.com/coding
ANTHROPIC_AUTH_TOKEN             <token>                  Sensitive
ANTHROPIC_MODEL                  kimi-k3
ANTHROPIC_DEFAULT_OPUS_MODEL     kimi-k3
ANTHROPIC_DEFAULT_SONNET_MODEL   kimi-k3
ANTHROPIC_DEFAULT_HAIKU_MODEL    kimi-k3
ANTHROPIC_SMALL_FAST_MODEL       kimi-k3
```

Add `kimi-k3` as a custom model on this instance.

### Leave The Credential Broker Empty

Don't set a credential broker URL on a route-profile instance. The broker injects Anthropic OAuth
credentials, which would fight the endpoint's own token.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `CLAUDE_CONFIG_DIR path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.

## Credential Broker

A credential broker is an account selector that picks which credentials Claude should use for a
session, determined by which machine is running the agent.

This is useful when you want multiple Claude instances — each with different accounts or API keys
— to share one T3 Code server. For example: your work laptop and personal laptop both connect to
the same T3 Code server, but each should use its own API credentials.

### Enable A Credential Broker

Edit your Claude provider in T3 Code Settings:

```text
Credential broker URL: https://broker.example.com
Credential broker token variable: AIGATE_TOKEN
```

The broker URL is the endpoint that T3 Code will call to select credentials. It must support
`GET /api/select` and return credentials specific to your hostname.

The token variable is the name of a sensitive environment variable on this instance that holds
your broker's bearer token. Leave it at the default `AIGATE_TOKEN` unless your broker uses a
different variable name.

### Add The Broker Token

Add a sensitive environment variable to this provider with the token value:

```text
AIGATE_TOKEN     <your-broker-token>     Sensitive
```

Mark it as sensitive so T3 Code stores it securely and does not send it back after saving.

### How It Works

When you start a session with this provider, T3 Code calls the broker endpoint with your
hostname. The broker returns account-specific credentials for this machine, which Claude then
uses for the session. If the broker is unreachable or returns an error, T3 Code logs a warning
and falls back to the instance's own credentials.

The broker endpoint must be aigate-compatible: it accepts `GET /api/select?host={hostname}` with
an `Authorization: Bearer {token}` header and returns JSON with `account` and `setup_token`
fields.

### Important: Use an Absolute Binary Path

When using a credential broker, **set your provider's `Binary path` to an absolute path** (e.g.,
`/usr/local/bin/claude`), not a bare `claude`. A bare path resolves through your system's PATH
and may pick up a wrapper script that injects its own credentials, silently overriding the
broker's injected credentials. An absolute path ensures T3 Code calls the real Claude binary with
your broker-selected credentials.
