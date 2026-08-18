#!/usr/bin/env bash
# e2e-aigate-routes — live end-to-end checks of every model route reachable via aigate,
# plus the rotation-on-limit primitive. Run from any box with ~/.claude/aigate/env.
# Impact: T2 parks one Claude account for 1 minute (self-heals). Everything else is
# read-only or a ~1-token completion. Never prints secrets.
set -uo pipefail
set -a; . "$HOME/.claude/aigate/env"; set +a
: "${AIGATE_URL:?}"; : "${AIGATE_TOKEN:?}"
AUTH=(-H "Authorization: Bearer $AIGATE_TOKEN")
CLAUDE_BIN="${AIGATE_CLAUDE_BIN:-$HOME/.local/bin/claude}"
HOST="$(hostname -s)"
P=0; F=0; S=0
pass(){ echo "  ✅ PASS — $1"; P=$((P+1)); }
fail(){ echo "  ❌ FAIL — $1"; F=$((F+1)); }
skip(){ echo "  ⚠️  SKIP — $1"; S=$((S+1)); }
jf(){ python3 -c "import sys,json
try: d=json.load(sys.stdin); print(d$1)
except Exception: print('')" 2>/dev/null; }

echo "== T1: Claude via aigate select (account with most headroom)"
R=$(curl -s -m8 "${AUTH[@]}" "$AIGATE_URL/api/select?host=$HOST")
A=$(printf '%s' "$R"|jf "['account']"); T=$(printf '%s' "$R"|jf "['setup_token']")
if [ -z "$T" ]; then fail "select returned no token: $(printf '%s' "$R"|head -c120)"; else
  D=$(mktemp -d); OUT=$(CLAUDE_CONFIG_DIR=$D CLAUDE_CODE_OAUTH_TOKEN="$T" "$CLAUDE_BIN" -p "Reply with exactly: PONG" --model claude-haiku-4-5-20251001 2>&1)
  case "$OUT" in *PONG*) pass "claude ran on brokered account '$A'";; *) fail "claude call failed on '$A': $(echo "$OUT"|head -c160)";; esac
fi

echo "== T2: rotation on usage limit (park → re-select picks a different account)"
# guard: parking eats one slot for 60s; need >=2 selectable or a back-to-back run
# false-fails on its own residue. Wait for TTL heal (max 75s) before parking.
for i in $(seq 1 15); do
  SEL=$(curl -s -m5 "$AIGATE_URL/health"|jf "['selectable']")
  [ "${SEL:-0}" -ge 2 ] 2>/dev/null && break; sleep 5
done
if [ "${SEL:-0}" -lt 2 ] 2>/dev/null; then skip "only ${SEL:-?} selectable account(s) — rotation needs 2+"; A=""; fi
if [ -n "${A:-}" ]; then
  curl -s -m5 -X POST "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"account\":\"$A\",\"host\":\"$HOST-e2e\",\"minutes\":1}" "$AIGATE_URL/api/events/limit" >/dev/null
  R2=$(curl -s -m8 "${AUTH[@]}" "$AIGATE_URL/api/select?host=$HOST")
  A2=$(printf '%s' "$R2"|jf "['account']"); T2=$(printf '%s' "$R2"|jf "['setup_token']")
  if [ -z "$A2" ]; then fail "no account left after parking '$A' (pool exhausted?)"
  elif [ "$A2" = "$A" ]; then fail "select returned parked account '$A' again"
  else
    pass "parked '$A' → select rotated to '$A2'"
    if [ -n "$T2" ]; then
      D2=$(mktemp -d); OUT2=$(CLAUDE_CONFIG_DIR=$D2 CLAUDE_CODE_OAUTH_TOKEN="$T2" "$CLAUDE_BIN" -p "Reply with exactly: PONG" --model claude-haiku-4-5-20251001 2>&1)
      case "$OUT2" in *PONG*) pass "rotated account '$A2' actually serves traffic";; *) fail "rotated account '$A2' call failed: $(echo "$OUT2"|head -c160)";; esac
    fi
  fi
  echo "  (park self-heals in 60s)"
else skip "no account from T1"; fi

echo "== T3: Muse API (Meta gateway, Anthropic-native /v1/messages)"
MK=$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.config/muse/auth.json"))["providers"]["meta"]["api_key"])' 2>/dev/null)
[ -z "$MK" ] && MK=$(curl -s -m8 "${AUTH[@]}" "$AIGATE_URL/api/keys/muse"|jf "['key']")
if [ -z "$MK" ]; then fail "no muse key in auth.json or vault"; else
  MR=$(curl -s -m20 -X POST https://api.meta.ai/v1/messages -H "Authorization: Bearer $MK" -H 'content-type: application/json' \
    -d '{"model":"muse-spark-1.2-contributor","max_tokens":16,"messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
  case "$MR" in *PONG*|*'"type":"message"'*) pass "muse-spark-1.2-contributor responded";; *) fail "muse: $(printf '%s' "$MR"|head -c160)";; esac
fi

echo "== T4: Qwen (vault key: qwen direct, else openrouter)"
QK=$(curl -s -m8 "${AUTH[@]}" "$AIGATE_URL/api/keys/qwen"|jf "['key']")
if [ -n "$QK" ]; then
  QR=$(curl -s -m20 -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions -H "Authorization: Bearer $QK" -H 'content-type: application/json' \
    -d '{"model":"qwen3.8-max","max_tokens":8,"messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
  case "$QR" in *PONG*|*'"choices"'*) pass "qwen via vaulted dashscope key";; *) fail "qwen direct: $(printf '%s' "$QR"|head -c160)";; esac
else
  OK=$(curl -s -m8 "${AUTH[@]}" "$AIGATE_URL/api/keys/openrouter"|jf "['key']")
  [ -z "$OK" ] && OK=$(cat "$HOME/.config/openrouter/key" 2>/dev/null)
  if [ -z "$OK" ]; then fail "no qwen key and no openrouter key"; else
    QR=$(curl -s -m30 -X POST https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OK" -H 'content-type: application/json' \
      -d '{"model":"qwen/qwen3.8-max","max_tokens":8,"messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
    case "$QR" in *PONG*|*'"choices"'*) pass "qwen3.8-max via openrouter (vault/local key)";; *) fail "qwen via openrouter: $(printf '%s' "$QR"|head -c200)";; esac
  fi
fi

echo "== T5: Kimi K3 (vaulted key, Anthropic-compatible endpoint)"
KK=$(cat "$HOME/.claude/aigate/kimi-key" 2>/dev/null)
[ -z "$KK" ] && KK=$(curl -s -m8 "${AUTH[@]}" "$AIGATE_URL/api/keys/kimi"|jf "['key']")
if [ -z "$KK" ]; then skip "no kimi key local or vaulted"; else
  KR=$(curl -s -m20 -X POST https://api.kimi.com/coding/v1/messages -H "Authorization: Bearer $KK" -H 'content-type: application/json' \
    -d '{"model":"kimi-k3","max_tokens":16,"messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
  case "$KR" in *PONG*|*'"type":"message"'*) pass "kimi-k3 responded";; *) fail "kimi: $(printf '%s' "$KR"|head -c160)";; esac
fi

echo "== T6: ChatGPT/Codex route (retired 2026-08-04 — measuring current truth)"
GK=$(curl -s -m8 "${AUTH[@]}" "$AIGATE_URL/api/keys/openai"|jf "['key']")
if [ -n "$GK" ]; then
  GR=$(curl -s -m20 https://api.openai.com/v1/models -H "Authorization: Bearer $GK" -o /dev/null -w '%{http_code}')
  case "$GR" in 200) pass "openai key in vault is live (rung may be revivable)";; *) fail "openai vault key HTTP $GR (documented retirement: 402 out-of-credits)";; esac
else skip "no openai key vaulted — matches retired-rung finding"; fi
if [ -s "$HOME/.codex/auth.json" ]; then
  echo "  ℹ️  codex has its own ChatGPT OAuth (~/.codex/auth.json) — OUTSIDE aigate; no rotation backend exists for it (council-verified)"
else echo "  ℹ️  no codex auth.json on this box"; fi

echo; echo "RESULT: $P pass, $F fail, $S skip"
[ "$F" = 0 ]