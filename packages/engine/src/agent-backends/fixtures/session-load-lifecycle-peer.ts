/** Own local ACP peer; its persistent session is genuine filesystem state, never a fabricated Engine row. */
export const sessionLoadLifecyclePeer = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const [, logPath, root] = process.argv.slice(2);
const modePath = join(root, "load-mode.txt");
const mode = existsSync(modePath) ? readFileSync(modePath, "utf8") : "source";
const statePath = join(root, "remote-session.txt");
let sessionId, promptId, loadId;
const log = (value) => appendFileSync(logPath, JSON.stringify(value) + "\n");
const send = (value) => { log({ type: "sent", message: value }); process.stdout.write(JSON.stringify(value) + "\n"); };
const update = (kind, text, messageId) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: kind, content: { type: "text", text }, messageId } } });
log({ type: "started", pid: process.pid, mode });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ type: "received", message });
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: mode !== "false-capability" } } });
  } else if (message.method === "session/new") {
    sessionId = "persisted-lifecycle-" + process.pid;
    writeFileSync(statePath, sessionId);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
  } else if (message.method === "session/load") {
    loadId = message.id;
    sessionId = message.params.sessionId;
    if (readFileSync(statePath, "utf8") !== sessionId) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Session not known" } });
      return;
    }
    update("user_message_chunk", "HISTORICAL_USER_DATA_ONLY", "old-user");
    update("agent_message_chunk", "HISTORICAL_ASSISTANT_DATA_ONLY", "old-answer");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "old-command", title: "Historical command observation", status: "completed", rawInput: { command: "echo OLD_DATA > historical-command.txt" }, rawOutput: { observed: true } } } });
    if (mode === "hold-load") return;
    if (mode.startsWith("effect-")) {
      const rawInput = { method: "fs/write_text_file", params: { sessionId, path: join(root, "forbidden-loaded-write.txt"), content: "MUST_NOT_BE_WRITTEN" } };
      const request = mode === "effect-permission"
        ? { method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "history-effect", rawInput }, options: [{ optionId: "grant", name: "Allow once", kind: "allow_once" }] } }
        : mode === "effect-terminal"
          ? { method: "terminal/create", params: { sessionId, command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid))", join(root, "forbidden-loaded-pid.txt")], cwd: root } }
          : rawInput;
      send({ jsonrpc: "2.0", id: "load-forbidden-effect", ...request });
      return;
    }
    send({ jsonrpc: "2.0", id: loadId, result: {} });
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", id: mode === "source" ? "source-read" : "loaded-read", method: "fs/read_text_file", params: { sessionId, path: join(root, "seed.txt"), line: 1, limit: 1 } });
  } else if (message.method === "session/cancel") {
    if (promptId) send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
    else if (loadId) send({ jsonrpc: "2.0", id: loadId, result: {} });
  } else if (Object.hasOwn(message, "result") && ["source-read", "loaded-read"].includes(message.id)) {
    update("agent_message_chunk", mode === "source" ? "SOURCE_CURRENT_ANSWER" : "LOADED_CURRENT_ANSWER", mode === "source" ? "source-current" : "loaded-current");
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;
