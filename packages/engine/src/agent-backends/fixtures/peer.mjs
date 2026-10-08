import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Synthetic wire peer, launched by the actual owned Engine process supervisor.
const [mode, logPath, root] = process.argv.slice(2);
let sessionId = `actual-peer-${process.pid}`;
let promptId;
let responseCount = 0;
const log = (value) => appendFileSync(logPath, JSON.stringify(value) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
log({ type: "started", pid: process.pid });
const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  const value = JSON.parse(text);
  log({ type: "received", message: value });
  if (value.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: value.id,
      result: { protocolVersion: mode === "v2" ? 2 : 1, agentCapabilities: {} },
    });
  } else if (value.method === "session/new") {
    send({ jsonrpc: "2.0", id: value.id, result: { sessionId } });
  } else if (value.method === "session/prompt") {
    promptId = value.id;
    if (mode === "eof") {
      process.stdout.end(() => process.exit(0));
      return;
    }
    if (mode === "ack") {
      send({ jsonrpc: "2.0", id: value.id, result: { messageId: "v2-ack" } });
      return;
    }
    if (mode === "hold") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "held" },
          },
        },
      });
      return;
    }
    if (mode === "unsupported") {
      send({
        jsonrpc: "2.0",
        id: "unsupported-write",
        method: "fs/write_text_file",
        params: {
          sessionId,
          path: join(root, "forbidden.txt"),
          content: "must not write",
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: "native-read",
      method: "fs/read_text_file",
      params: {
        sessionId,
        path: join(root, mode === "partial" ? "large.txt" : "seed.txt"),
        line: 1,
        limit: mode === "partial" ? 2000 : 2,
      },
    });
  } else if (value.method === "session/cancel") {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  } else if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) {
    responseCount++;
    if (mode === "duplicate-read" && responseCount === 1) {
      send({
        jsonrpc: "2.0",
        id: "native-read",
        method: "fs/read_text_file",
        params: { sessionId, path: join(root, "seed.txt"), line: 1, limit: 2 },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Actual peer received the native read.\n",
          },
        },
      },
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
