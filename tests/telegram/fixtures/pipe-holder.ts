import assert from "node:assert/strict";
import net from "node:net";

// Keep inherited RPC stdout/stderr open after Pi exits. The test owns this independent control socket.
assert.equal(process.argv.length, 3);
const socket = net.connect(process.argv[2], () => socket.write(`${process.pid}\n`));
socket.on("data", () => process.exit(0));
socket.on("end", () => process.exit(0));
socket.on("error", () => process.exit(1));
