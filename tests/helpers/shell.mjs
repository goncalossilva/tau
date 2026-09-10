import { connect } from "node:net";

// A real, single-process Bash workload. Its owned connection also permits failure-safe teardown.
const socket = connect(Number(process.argv[2]), "127.0.0.1");
socket.on("connect", () => socket.write(`${process.pid}\n`));
socket.on("end", () => process.exit(0));
socket.on("error", () => process.exit(1));
