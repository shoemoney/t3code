// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkClaudeProviderStatus, probeClaudeCapabilities } from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * A real dev machine may already export AIGATE_ACCOUNT / CLAUDE_CODE_OAUTH_TOKEN
 * (this repo's own aigate tooling does). Strip them so the "baseline" case can't
 * be contaminated into looking brokered by ambient environment.
 */
function cleanBaseEnvironment(): NodeJS.ProcessEnv {
  const { AIGATE_ACCOUNT: _account, CLAUDE_CODE_OAUTH_TOKEN: _token, ...rest } = process.env;
  return rest;
}

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

/**
 * A fake `claude` binary that answers `--version` (for checkClaudeProviderStatus's
 * health check) and the SDK's initialize control request (for probeClaudeCapabilities),
 * reporting an account shaped by whatever env reached the subprocess — so a test can
 * tell a brokered spawn apart from a baseline one.
 */
const FAKE_CLAUDE_SOURCE = [
  "#!/usr/bin/env node",
  'import { createInterface } from "node:readline";',
  "const args = process.argv.slice(2);",
  'if (args[0] === "--version") {',
  '  process.stdout.write("2.1.219 (Claude Code)\\n");',
  "  process.exit(0);",
  "}",
  "const lines = createInterface({ input: process.stdin });",
  'lines.on("line", (line) => {',
  "  const message = JSON.parse(line);",
  '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
  "  process.stdout.write(JSON.stringify({",
  '    type: "control_response",',
  "    response: {",
  '      subtype: "success",',
  "      request_id: message.request_id,",
  "      response: {",
  "        commands: [],",
  "        agents: [],",
  '        output_style: "default",',
  '        available_output_styles: ["default"],',
  "        models: [],",
  "        account: {",
  '          email: process.env.AIGATE_ACCOUNT || "baseline@instance.test",',
  '          subscriptionType: "pro",',
  '          tokenSource: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "broker" : "baseline",',
  "        },",
  "      },",
  "    },",
  '  }) + "\\n");',
  "});",
  "setInterval(() => {}, 1_000);",
  "",
].join("\n");

it.layer(NodeServices.layer)("Claude provider status broker resolution", (it) => {
  it.effect(
    "case 1: a non-empty brokerUrl resolves the brokered account before probing, and the draft's auth block reflects it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-broker-status-" });
        const executablePath = path.join(tempDir, "fake-claude.mjs");
        yield* fs.writeFileString(executablePath, FAKE_CLAUDE_SOURCE);
        yield* fs.chmod(executablePath, 0o755);

        let brokerRequestCount = 0;
        const brokerServer = NodeHttp.createServer((_req, res) => {
          brokerRequestCount += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ setup_token: "sk-brokered-token", account: "acct-brokered" }));
        });
        const brokerPort = yield* Effect.promise(() => listen(brokerServer));

        const claudeSettings = decodeClaudeSettings({
          binaryPath: executablePath,
          brokerUrl: `http://127.0.0.1:${brokerPort}`,
          brokerTokenEnv: "T3_TEST_BROKER_TOKEN",
        });
        const environment = {
          ...cleanBaseEnvironment(),
          T3_TEST_BROKER_TOKEN: "instance-bearer-token",
        };

        const capabilities = yield* probeClaudeCapabilities(claudeSettings, environment);
        assert.equal(capabilities?.email, "acct-brokered");
        assert.equal(capabilities?.tokenSource, "broker");
        assert.equal(brokerRequestCount, 1);

        const status = yield* checkClaudeProviderStatus(
          claudeSettings,
          (settings) =>
            probeClaudeCapabilities(settings, environment).pipe(
              Effect.provideService(Path.Path, path),
            ),
          environment,
        );
        assert.equal(status.auth.status, "authenticated");
        assert.equal(status.auth.email, "acct-brokered");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "case 2: an empty brokerUrl short-circuits without a network call, leaving the baseline account and draft unchanged",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-broker-status-" });
        const executablePath = path.join(tempDir, "fake-claude.mjs");
        yield* fs.writeFileString(executablePath, FAKE_CLAUDE_SOURCE);
        yield* fs.chmod(executablePath, 0o755);

        let brokerRequestCount = 0;
        const brokerServer = NodeHttp.createServer((_req, res) => {
          brokerRequestCount += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ setup_token: "sk-brokered-token", account: "acct-brokered" }));
        });
        // Server is created but never handed to the instance below — brokerUrl stays
        // empty, so a passing test here must not depend on this server at all.
        yield* Effect.promise(() => listen(brokerServer));

        const claudeSettings = decodeClaudeSettings({ binaryPath: executablePath });
        const environment = cleanBaseEnvironment();

        const capabilities = yield* probeClaudeCapabilities(claudeSettings, environment);
        assert.equal(capabilities?.email, "baseline@instance.test");
        assert.equal(capabilities?.tokenSource, "baseline");
        assert.equal(brokerRequestCount, 0);

        const status = yield* checkClaudeProviderStatus(
          claudeSettings,
          (settings) =>
            probeClaudeCapabilities(settings, environment).pipe(
              Effect.provideService(Path.Path, path),
            ),
          environment,
        );
        assert.equal(status.auth.status, "authenticated");
        assert.equal(status.auth.email, "baseline@instance.test");
      }).pipe(Effect.scoped),
  );
});
