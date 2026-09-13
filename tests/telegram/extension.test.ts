import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import {
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { assistantMessage, createPiResources, fixtureModel, isolatePiHome } from "../helpers/pi.js";
import { scriptedProvider } from "../helpers/provider.js";

const reply = "The otter keeps its report in the parent window.";

describe("Telegram extension opt-out", { concurrency: false }, () => {
  let home: Awaited<ReturnType<typeof isolatePiHome>>;
  let telegram: typeof import("../../extensions/telegram/index.js").default;
  let previous: Record<string, string | undefined>;
  let failures: unknown[];
  let resources: Awaited<ReturnType<typeof createPiResources>> | undefined;
  let session: AgentSession | undefined;

  before(async () => {
    home = await isolatePiHome();
    telegram = (await import("../../extensions/telegram/index.js")).default;
  });

  after(async () => {
    await home.dispose();
  });

  beforeEach(() => {
    previous = Object.fromEntries(
      ["PI_SUBAGENT", "PI_TELEGRAM_DISABLE", "PI_TELEGRAM_BOT_TOKEN"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    delete process.env.PI_SUBAGENT;
    delete process.env.PI_TELEGRAM_DISABLE;
    // A synthetic token avoids personal Keychain access even in the enabled parent case.
    process.env.PI_TELEGRAM_BOT_TOKEN = "fixture-only-not-a-bot-token";
    failures = [];
    rejectExternalWork(failures);
    mock.timers.enable({ apis: ["setInterval"] });
  });

  afterEach(async () => {
    try {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await session.abort();
        await session.waitForIdle();
      }
      await resources?.settingsManager.flush();
      assert.deepEqual(failures, [], "unexpected external work and extension errors must fail");
    } finally {
      session?.dispose();
      session = undefined;
      resources = undefined;
      mock.timers.reset();
      mock.restoreAll();
      syncBuiltinESMExports();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(getAgentDir(), { recursive: true, force: true });
    }
  });

  for (const marker of ["PI_SUBAGENT", "PI_TELEGRAM_DISABLE", undefined] as const) {
    test(`${marker ? `${marker}=1 hides Telegram` : "an ordinary parent retains /telegram"} through a completed turn`, async () => {
      const agentDir = getAgentDir();
      const cwd = path.join(agentDir, "otter-workshop");
      await mkdir(cwd, { recursive: true });
      if (marker) {
        process.env[marker] = "1";
        // Opt-out must win even when inherited settings would otherwise auto-connect.
        await mkdir(path.join(agentDir, "telegram"));
        await writeFile(
          path.join(agentDir, "telegram", "config.json"),
          JSON.stringify({ pairedChatId: 42 }),
        );
      }

      let api!: ExtensionAPI;
      let requests = 0;
      resources = await createPiResources(cwd, agentDir, [
        telegram,
        (pi) => {
          api = pi;
        },
        scriptedProvider(fixtureModel, ({ context }) => {
          requests++;
          assert.deepEqual(context.tools ?? [], [], "no Telegram tool reaches the model");
          return assistantMessage(reply);
        }),
      ]);
      ({ session } = await createAgentSession({ ...resources, model: fixtureModel, tools: [] }));
      await session.bindExtensions({
        mode: "print",
        onError: (error) => failures.push(error),
      });

      assert.deepEqual(
        api.getCommands().map(({ name }) => name),
        marker ? [] : ["telegram"],
      );
      assert.equal(
        session.getAllTools().some(({ name }) => name === "telegram_send_file"),
        false,
      );
      await session.prompt("Keep the report local.");
      await session.waitForIdle();
      if (marker) mock.timers.tick(6000);
      assert.equal(requests, 1);
      const result = session.messages.at(-1);
      assert.equal(result?.role, "assistant");
      assert.ok(result && "content" in result);
      assert.deepEqual(result.content, [{ type: "text", text: reply }]);
      assert.deepEqual(failures, [], "startup, settlement and reconnect ticks stay offline");
    });
  }
});

/** No real daemon, bot, Keychain or model network is allowed. Pi's lifecycle and generation orchestration stay real. */
function rejectExternalWork(failures: unknown[]) {
  const reject = () => {
    const error = new Error(
      "Unexpected subprocess or network request in Telegram opt-out workflow",
    );
    failures.push(error);
    throw error;
  };
  mock.method(globalThis, "fetch", reject);
  mock.method(net, "connect", reject);
  mock.method(net, "createConnection", reject);
  for (const method of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ] as const)
    mock.method(childProcess, method, reject);
  syncBuiltinESMExports();
}
