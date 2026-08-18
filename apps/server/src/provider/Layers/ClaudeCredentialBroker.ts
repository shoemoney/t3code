/**
 * ClaudeCredentialBroker - Generic account-selector broker for Claude sessions.
 *
 * At session start, when an instance has a broker URL configured, calls
 * `GET {brokerUrl}/api/select?host={host}` with a bearer token read from the
 * instance environment, and resolves the credentials to overlay onto the
 * captured Claude environment for that query only. Never fails: every
 * failure mode collapses into a `BrokerResolution` tag so callers can log
 * loudly and fall back to the instance's own credentials.
 *
 * Uses global fetch with AbortSignal.timeout rather than the Effect
 * HttpClient: the abort signal bounds the WHOLE exchange including the body
 * read. A broker that sends 200 + headers and then stalls its body must not
 * hang turn start — fiber interruption alone cannot reclaim a pending body
 * read (measured: a stalled read survived Effect.timeoutOption).
 *
 * `unreachable` details are deliberately generic (HTTP status, "not valid
 * JSON") rather than echoing response bodies — a body snippet could leak a
 * secret from a misbehaving broker into logs.
 *
 * @module ClaudeCredentialBroker
 */
// @effect-diagnostics globalFetchInEffect:off -- deliberate: HttpClient's body read
// cannot be reclaimed by fiber interruption (a stalled broker body hung past a
// 120s test timeout); AbortSignal.timeout bounds the whole exchange.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const BROKER_REQUEST_TIMEOUT_MS = 8000;

/** Default env var name holding the broker bearer token when the instance leaves `brokerTokenEnv` unset. */
export const DEFAULT_BROKER_TOKEN_ENV = "AIGATE_TOKEN";

export type BrokerResolution =
  | { readonly _tag: "ok"; readonly account: string; readonly env: Record<string, string> }
  | { readonly _tag: "disabled" }
  | { readonly _tag: "unreachable"; readonly detail: string }
  | { readonly _tag: "unauthorized" }
  | { readonly _tag: "no-headroom"; readonly accounts?: number };

const BrokerSelectResponse = Schema.Struct({
  setup_token: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  accounts: Schema.optional(Schema.Number),
});

const decodeBrokerSelectResponse = Schema.decodeUnknownSync(BrokerSelectResponse);

function classifyPayload(payload: unknown): BrokerResolution {
  let decoded: typeof BrokerSelectResponse.Type;
  try {
    decoded = decodeBrokerSelectResponse(payload);
  } catch {
    return { _tag: "unreachable", detail: "broker response was not valid JSON" };
  }
  const { setup_token: setupToken, account, accounts } = decoded;
  if (setupToken) {
    return {
      _tag: "ok",
      account: account ?? "",
      env: { CLAUDE_CODE_OAUTH_TOKEN: setupToken, AIGATE_ACCOUNT: account ?? "" },
    };
  }
  if (typeof accounts === "number") return { _tag: "no-headroom", accounts };
  return { _tag: "unreachable", detail: "broker response missing setup_token" };
}

/** Resolves the credential env overlay for a session's broker, if configured. Never fails. */
export const resolveBrokerEnvironment = Effect.fn("resolveBrokerEnvironment")(function* (input: {
  readonly brokerUrl: string;
  readonly token: string | undefined;
  readonly host: string;
  /** Accounts to skip on this resolution — the hop's exclude list. Sent as `&exclude=a,b`. */
  readonly exclude?: ReadonlyArray<string>;
  /** Test seam only — production callers use the 8s default. */
  readonly timeoutMs?: number;
}) {
  const brokerUrl = input.brokerUrl.trim();
  if (brokerUrl === "") return { _tag: "disabled" } as const;
  const token = input.token;
  if (!token) return { _tag: "unauthorized" } as const;

  const excludeParam =
    input.exclude && input.exclude.length > 0
      ? `&exclude=${encodeURIComponent(input.exclude.join(","))}`
      : "";
  const selectUrl = `${brokerUrl.replace(/\/+$/, "")}/api/select?host=${encodeURIComponent(input.host)}${excludeParam}`;
  const timeoutMs = input.timeoutMs ?? BROKER_REQUEST_TIMEOUT_MS;

  return yield* Effect.tryPromise({
    try: async (): Promise<BrokerResolution> => {
      const response = await fetch(selectUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401) return { _tag: "unauthorized" };
      if (!response.ok) {
        return { _tag: "unreachable", detail: `broker responded HTTP ${response.status}` };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        // A stalled body aborts via the signal — that is a timeout, not bad JSON.
        const name = cause instanceof Error ? cause.name : "";
        if (name === "TimeoutError" || name === "AbortError") throw cause;
        return { _tag: "unreachable", detail: "broker response was not valid JSON" };
      }
      return classifyPayload(payload);
    },
    catch: () => undefined,
  }).pipe(
    Effect.orElseSucceed(
      (): BrokerResolution => ({
        _tag: "unreachable",
        detail: "broker request failed or timed out",
      }),
    ),
  );
});

/** Overlays a broker resolution's env onto the base env. Passthrough unless `ok`. Pure, unit-testable. */
export function applyBrokerResolution(
  baseEnv: NodeJS.ProcessEnv,
  resolution: BrokerResolution,
): NodeJS.ProcessEnv {
  return resolution._tag === "ok" ? { ...baseEnv, ...resolution.env } : baseEnv;
}

/**
 * Reports a rate-limited account to the broker so it can be parked. Fire-and-forget:
 * never fails, never logs the token. Resolves `true` only on a 2xx response.
 */
export const reportBrokerLimit = Effect.fn("reportBrokerLimit")(function* (input: {
  readonly brokerUrl: string;
  readonly token: string;
  readonly account: string;
  readonly minutes?: number;
}) {
  const url = `${input.brokerUrl.replace(/\/+$/, "")}/api/events/limit`;
  return yield* Effect.tryPromise({
    try: async (): Promise<boolean> => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fire-and-forget wire body, not a decoded value.
        body: JSON.stringify({
          account: input.account,
          ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
        }),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed((): boolean => false));
});

/**
 * Pure classifier for a turn's terminal error text. Mirrors the field-proven warden
 * classifier: overloaded (Anthropic-global load shed) is checked first and never
 * triggers a hop — only rate-limit does.
 */
export function classifyClaudeFailure(text: string): "rate-limit" | "overloaded" | "other" {
  if (/overloaded|529/i.test(text)) return "overloaded";
  if (
    /rate.?limit|usage limit|too many requests|429|quota|reached your (usage|limit)/i.test(text)
  ) {
    return "rate-limit";
  }
  return "other";
}
