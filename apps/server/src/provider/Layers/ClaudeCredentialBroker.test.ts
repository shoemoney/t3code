// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyBrokerResolution,
  classifyClaudeFailure,
  reportBrokerLimit,
  resolveBrokerEnvironment,
} from "./ClaudeCredentialBroker.ts";

const servers: NodeHttp.Server[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("resolveBrokerEnvironment", () => {
  it.effect("case 1: ok select overlays CLAUDE_CODE_OAUTH_TOKEN and AIGATE_ACCOUNT", () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ setup_token: "sk-broker-token", account: "acct-1" }));
      });
      const port = yield* Effect.promise(() => listen(server));

      const resolution = yield* resolveBrokerEnvironment({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        host: "test-host",
      });

      expect(resolution).toEqual({
        _tag: "ok",
        account: "acct-1",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-broker-token", AIGATE_ACCOUNT: "acct-1" },
      });
    }),
  );

  it.effect("case 2: HTTP 401 resolves unauthorized", () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer((_req, res) => {
        res.writeHead(401);
        res.end();
      });
      const port = yield* Effect.promise(() => listen(server));

      const resolution = yield* resolveBrokerEnvironment({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        host: "test-host",
      });

      expect(resolution).toEqual({ _tag: "unauthorized" });
    }),
  );

  it.effect("case 3: no-headroom JSON resolves no-headroom with account count", () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accounts: 3, parked: 1 }));
      });
      const port = yield* Effect.promise(() => listen(server));

      const resolution = yield* resolveBrokerEnvironment({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        host: "test-host",
      });

      expect(resolution).toEqual({ _tag: "no-headroom", accounts: 3 });
    }),
  );

  it.effect("case 4: connection refused resolves unreachable", () =>
    Effect.gen(function* () {
      // Bind and immediately close to obtain a port nothing is listening on.
      const probe = NodeHttp.createServer();
      const closedPort = yield* Effect.promise(() => listen(probe));
      yield* Effect.promise(() => new Promise<void>((resolve) => probe.close(() => resolve())));
      servers.splice(servers.indexOf(probe), 1);

      const resolution = yield* resolveBrokerEnvironment({
        brokerUrl: `http://127.0.0.1:${closedPort}`,
        token: "bearer-token",
        host: "test-host",
      });

      expect(resolution._tag).toBe("unreachable");
    }),
  );

  it.effect("case 5: empty brokerUrl resolves disabled without a network call", () =>
    Effect.gen(function* () {
      const resolution = yield* resolveBrokerEnvironment({
        brokerUrl: "",
        token: "bearer-token",
        host: "test-host",
      });

      expect(resolution).toEqual({ _tag: "disabled" });
    }),
  );

  it.effect("case 6: missing token resolves unauthorized without any HTTP call", () =>
    Effect.gen(function* () {
      const resolution = yield* resolveBrokerEnvironment({
        brokerUrl: "http://127.0.0.1:1",
        token: undefined,
        host: "test-host",
      });

      expect(resolution).toEqual({ _tag: "unauthorized" });
    }),
  );

  it.effect(
    "case 8: 200 with a stalled body resolves unreachable within the timeout",
    () =>
      Effect.gen(function* () {
        const server = NodeHttp.createServer((_req, res) => {
          // Headers + partial body, then silence: the read must not hang turn start.
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{");
        });
        const port = yield* Effect.promise(() => listen(server));

        const resolution = yield* resolveBrokerEnvironment({
          brokerUrl: `http://127.0.0.1:${port}`,
          token: "bearer-token",
          host: "test-host",
          timeoutMs: 500,
        });

        expect(resolution._tag).toBe("unreachable");
        // The 5s test timeout is the hang guard: without the abort signal this
        // case runs into the suite's 120s ceiling.
      }),
    5000,
  );

  it.effect("case 9: exclude list lands on the wire as a comma-joined query param", () =>
    Effect.gen(function* () {
      let receivedUrl = "";
      const server = NodeHttp.createServer((req, res) => {
        receivedUrl = req.url ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ setup_token: "sk-broker-token", account: "acct-2" }));
      });
      const port = yield* Effect.promise(() => listen(server));

      yield* resolveBrokerEnvironment({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        host: "test-host",
        exclude: ["acct-1", "acct-2"],
      });

      expect(receivedUrl).toBe("/api/select?host=test-host&exclude=acct-1%2Cacct-2");
    }),
  );

  it.effect("case 10: no exclude entries omits the query param entirely", () =>
    Effect.gen(function* () {
      let receivedUrl = "";
      const server = NodeHttp.createServer((req, res) => {
        receivedUrl = req.url ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ setup_token: "sk-broker-token", account: "acct-1" }));
      });
      const port = yield* Effect.promise(() => listen(server));

      yield* resolveBrokerEnvironment({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        host: "test-host",
        exclude: [],
      });

      expect(receivedUrl).toBe("/api/select?host=test-host");
    }),
  );
});

describe("reportBrokerLimit", () => {
  it.effect("case 11: posts account and minutes to the wire, returns true on 2xx", () =>
    Effect.gen(function* () {
      let receivedUrl = "";
      let receivedMethod = "";
      let receivedAuth = "";
      let receivedBody = "";
      const server = NodeHttp.createServer((req, res) => {
        receivedUrl = req.url ?? "";
        receivedMethod = req.method ?? "";
        receivedAuth = req.headers.authorization ?? "";
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          receivedBody = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      const port = yield* Effect.promise(() => listen(server));

      const result = yield* reportBrokerLimit({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        account: "acct-1",
        minutes: 30,
      });

      expect(result).toBe(true);
      expect(receivedUrl).toBe("/api/events/limit");
      expect(receivedMethod).toBe("POST");
      expect(receivedAuth).toBe("Bearer bearer-token");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - test assertion on a raw wire body.
      expect(JSON.parse(receivedBody)).toEqual({ account: "acct-1", minutes: 30 });
    }),
  );

  it.effect("case 12: omits minutes from the body when not provided", () =>
    Effect.gen(function* () {
      let receivedBody = "";
      const server = NodeHttp.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          receivedBody = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      const port = yield* Effect.promise(() => listen(server));

      yield* reportBrokerLimit({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        account: "acct-1",
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off - test assertion on a raw wire body.
      expect(JSON.parse(receivedBody)).toEqual({ account: "acct-1" });
    }),
  );

  it.effect("case 13: HTTP 500 resolves false, never fails", () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer((_req, res) => {
        res.writeHead(500);
        res.end();
      });
      const port = yield* Effect.promise(() => listen(server));

      const result = yield* reportBrokerLimit({
        brokerUrl: `http://127.0.0.1:${port}`,
        token: "bearer-token",
        account: "acct-1",
      });

      expect(result).toBe(false);
    }),
  );

  it.effect("case 14: connection refused resolves false, never fails", () =>
    Effect.gen(function* () {
      const probe = NodeHttp.createServer();
      const closedPort = yield* Effect.promise(() => listen(probe));
      yield* Effect.promise(() => new Promise<void>((resolve) => probe.close(() => resolve())));
      servers.splice(servers.indexOf(probe), 1);

      const result = yield* reportBrokerLimit({
        brokerUrl: `http://127.0.0.1:${closedPort}`,
        token: "bearer-token",
        account: "acct-1",
      });

      expect(result).toBe(false);
    }),
  );

  it.effect(
    "case 15: a stalled response resolves false within the timeout",
    () =>
      Effect.gen(function* () {
        const server = NodeHttp.createServer((_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          // Never end the response — the request read must not hang.
        });
        const port = yield* Effect.promise(() => listen(server));

        const result = yield* reportBrokerLimit({
          brokerUrl: `http://127.0.0.1:${port}`,
          token: "bearer-token",
          account: "acct-1",
        });

        expect(result).toBe(false);
      }),
    7000,
  );
});

describe("classifyClaudeFailure", () => {
  it("case 16: overloaded/529 text classifies as overloaded, checked before rate-limit", () => {
    expect(classifyClaudeFailure("Claude is currently overloaded")).toBe("overloaded");
    expect(classifyClaudeFailure("HTTP 529")).toBe("overloaded");
    // Overloaded wins even when rate-limit words are also present.
    expect(classifyClaudeFailure("529: rate limit exceeded due to overload")).toBe("overloaded");
  });

  it("case 17: rate-limit phrasing classifies as rate-limit", () => {
    expect(classifyClaudeFailure("Rate limit exceeded")).toBe("rate-limit");
    expect(classifyClaudeFailure("You have hit your usage limit")).toBe("rate-limit");
    expect(classifyClaudeFailure("too many requests")).toBe("rate-limit");
    expect(classifyClaudeFailure("HTTP 429")).toBe("rate-limit");
    expect(classifyClaudeFailure("quota exceeded")).toBe("rate-limit");
    expect(classifyClaudeFailure("You have reached your usage limit")).toBe("rate-limit");
  });

  it("case 18: anything else classifies as other", () => {
    expect(classifyClaudeFailure("network connection reset")).toBe("other");
    expect(classifyClaudeFailure("")).toBe("other");
  });
});

describe("applyBrokerResolution", () => {
  it("case 7: overlays env on ok, passes through unchanged otherwise", () => {
    const baseEnv = { PATH: "/usr/bin", HOME: "/home/test" };

    const overlaid = applyBrokerResolution(baseEnv, {
      _tag: "ok",
      account: "acct-1",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-broker-token", AIGATE_ACCOUNT: "acct-1" },
    });
    expect(overlaid).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-broker-token",
      AIGATE_ACCOUNT: "acct-1",
    });

    expect(applyBrokerResolution(baseEnv, { _tag: "disabled" })).toBe(baseEnv);
    expect(applyBrokerResolution(baseEnv, { _tag: "unauthorized" })).toBe(baseEnv);
    expect(applyBrokerResolution(baseEnv, { _tag: "unreachable", detail: "x" })).toBe(baseEnv);
    expect(applyBrokerResolution(baseEnv, { _tag: "no-headroom", accounts: 2 })).toBe(baseEnv);
  });
});
