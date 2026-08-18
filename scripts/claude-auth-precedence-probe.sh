#!/usr/bin/env bash
# claude-auth-precedence-probe.sh
#
# Regression probe for the credential broker's core safety assumption
# (plan.md EXP-1 / test T4): the broker overlays CLAUDE_CODE_OAUTH_TOKEN into
# the env for a single query, trusting that the `claude` binary actually uses
# that env token rather than falling back to a config-dir login stored from a
# prior interactive session. If a stored login silently shadows the env
# token, broker-injected credentials would be ignored and the wrong account's
# session would run instead.
#
# This script proves the precedence holds: with a FRESH CLAUDE_CONFIG_DIR
# (no stored login) and an obviously bogus CLAUDE_CODE_OAUTH_TOKEN, the CLI
# must fail its auth check rather than succeed. If it succeeds, something
# else (a global login, a different env var, a cached credential) is
# shadowing the broker's env token, and it is unsafe to rely on this seam.
#
# A bogus env token failing proves nothing on its own: on a machine with no
# reachable Claude login at all (no CLAUDE_CONFIG_DIR login, no OS keychain
# entry), the call 401s whether or not the env token was ever consulted. So
# this script first runs a CONTROL call — same fresh config dir, no env
# token — and requires it to SUCCEED, proving a stored/keychain login is
# actually reachable. Only then does a bogus-token 401 mean anything. If the
# control fails, the probe SKIPS loudly instead of reporting a hollow PASS.
#
# PASS (exit 0): control call succeeds, then the bogus-token call fails with
#   a 401 / invalid-token style auth error.
# SKIP (exit 0, loud): no reachable login on this machine — precedence was
#   never exercised.
# FAIL (exit 1): the bogus-token call succeeds, or fails for an unrelated
#   reason.
#
# Usage: ./scripts/claude-auth-precedence-probe.sh
# Override the binary under test: CLAUDE_BIN=/path/to/claude ./scripts/claude-auth-precedence-probe.sh

set -euo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
# Name the binary actually under test: agent runners (e.g. cmux) prepend PATH shims
# that wrap claude and inject their own credentials — a probe run against a shim
# reports the SHIM's auth behavior and its verdict is worthless. Measured: such a
# shim made a bogus-token call succeed, faking a shadowing failure.
RESOLVED_BIN="$(command -v "$CLAUDE_BIN" || true)"
echo "binary under test: ${RESOLVED_BIN:-$CLAUDE_BIN}"
case "$RESOLVED_BIN" in
  *shim*|*/T/*|/tmp/*|/private/tmp/*)
    echo "FAIL: resolved binary looks like a PATH shim, not the real claude." >&2
    echo "FAIL: rerun with CLAUDE_BIN=/path/to/real/claude." >&2
    exit 1
    ;;
esac

if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "FAIL: '$CLAUDE_BIN' not found on PATH (set CLAUDE_BIN to override)" >&2
  exit 1
fi

TMP_CONFIG_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_CONFIG_DIR"; }
trap cleanup EXIT

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"; cleanup' EXIT

# Strip ambient credential env vars: on a broker-equipped box CLAUDE_CODE_OAUTH_TOKEN
# or ANTHROPIC_* are routinely exported, and the control would "succeed" via those —
# proving nothing about a stored login. Only the config-dir/keychain login may answer.
set +e
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  CLAUDE_CONFIG_DIR="$TMP_CONFIG_DIR" \
  "$CLAUDE_BIN" -p "say OK" --model claude-haiku-4-5-20251001 \
  >"$OUTPUT_FILE" 2>&1
CONTROL_EXIT_CODE=$?
set -e

if [ "$CONTROL_EXIT_CODE" -ne 0 ]; then
  echo "SKIP: control call (no env token, fresh config dir) failed — no reachable stored/keychain" >&2
  echo "SKIP: login on this machine, so a bogus-token 401 would prove nothing. Log in and retry." >&2
  exit 0
fi

set +e
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  CLAUDE_CONFIG_DIR="$TMP_CONFIG_DIR" \
  CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-obviously-bogus-probe-token" \
  "$CLAUDE_BIN" -p "say OK" --model claude-haiku-4-5-20251001 \
  >"$OUTPUT_FILE" 2>&1
EXIT_CODE=$?
set -e

OUTPUT="$(cat "$OUTPUT_FILE")"
echo "--- claude output (exit $EXIT_CODE) ---"
echo "$OUTPUT"
echo "----------------------------------------"

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "FAIL: call SUCCEEDED with a bogus CLAUDE_CODE_OAUTH_TOKEN and a fresh config dir." >&2
  echo "FAIL: a stored login is shadowing the env token — broker credential injection is UNSAFE on this binary." >&2
  exit 1
fi

if echo "$OUTPUT" | grep -qiE "401|invalid[ _-]?(api[ _-]?key|token)|unauthorized|authentication"; then
  echo "PASS: control call succeeded (login reachable), bogus-token call failed with an auth error."
  exit 0
fi

echo "FAIL: call failed, but not with a recognizable auth error — investigate before trusting this seam." >&2
exit 1
