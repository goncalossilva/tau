import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {} from "./pipe-holder.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assistantMessage, fixtureModel } from "../../helpers/pi.js";
import { scriptedProvider } from "../../helpers/provider.js";

/** Real public lifecycle hook, with an IPC gate instead of a slow external startup connection. */
export default function (pi: ExtensionAPI) {
  let release: (() => void) | undefined;
  let releaseModel: (() => void) | undefined;
  pi.registerCommand("otter-rest", {
    handler: async () => {},
  });
  const onControl = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "release-model"
    ) {
      assert.ok(releaseModel, "No model is waiting for release");
      releaseModel();
      return;
    }
    assert.deepEqual(message, { type: "release-preflight" });
    assert.ok(release, "No preflight is waiting for release");
    release();
    release = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    process.removeListener("message", onControl);
    process.on("message", onControl);
    process.send!({ type: "session", file: ctx.sessionManager.getSessionFile() });
  });
  pi.on("session_shutdown", () => {
    process.removeListener("message", onControl);
  });
  pi.on("before_agent_start", async (event) => {
    if (!event.prompt.startsWith("delay:")) return;
    if (event.prompt === "delay: inherited pipes") {
      const descendant = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./pipe-holder.js", import.meta.url)),
          path.join(path.dirname(process.env.PI_CODING_AGENT_DIR!), "pipe-holder.sock"),
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      await once(descendant, "spawn");
    }
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    process.send!({ type: "preflight", text: event.prompt });
    await gate;
  });
  scriptedProvider(fixtureModel, async ({ context }, signal) => {
    const message = context.messages.findLast((message) => message.role === "user");
    assert.ok(message && message.role === "user");
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    process.send!({ type: "model", text });
    if (text.startsWith("hold:")) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          process.send!({ type: "model-aborted", text });
          reject(new Error("Model fixture aborted"));
        };
        releaseModel = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }).finally(() => {
        releaseModel = undefined;
      });
    }
    return assistantMessage(`Reply: ${text}`);
  })(pi);
}
