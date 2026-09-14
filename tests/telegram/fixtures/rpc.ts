// Launch the public RPC entrypoint with real Pi configuration and no resource or network discovery.
import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

assert.deepEqual(process.argv.slice(2), ["--mode", "rpc"]);
assert.equal(getAgentDir(), process.env.PI_CODING_AGENT_DIR);
assert.equal(process.env.TAU_TELEGRAM_DISABLE, "1");
globalThis.fetch = async () => {
  throw new Error("Unexpected network request in Telegram RPC fixture");
};
process.argv.push(
  "--offline",
  "--no-extensions",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
);
const rpcEntry = "@earendil-works/pi-coding-agent/rpc-entry";
await import(rpcEntry);
