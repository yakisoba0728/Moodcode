import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const [mode, logPath, root] = process.argv.slice(2);
const sessionId = `effect-session-${process.pid}`;
let promptId, terminalId;
let liveWait = false,
  liveKill = false;
const log = (value) => appendFileSync(logPath, JSON.stringify(value) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
log({ type: "started", pid: process.pid });
const write = {
  sessionId,
  path: join(root, "effect.txt"),
  content: "Approved exact native ACP write.\n",
};
const command =
  mode.includes("hold") || mode.includes("kill")
    ? `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync("command-pid",String(process.pid));const child=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync("command-child-pid",String(child.pid));require("fs").writeFileSync("command-ready","ready\\n");process.stdout.write("running live output\\n");setInterval(()=>{},1000)'`
    : `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync("command.txt","actual command");process.stdout.write("actual native terminal output\\n")'`;
const terminal = {
  sessionId,
  command:
    mode === "terminal-fail"
      ? `${JSON.stringify(process.execPath)} -e 'process.stdout.write("partial before failure");process.exit(7)'`
      : command,
  cwd: root,
  outputByteLimit: 8192,
};
if (mode === "terminal-args") {
  terminal.command = process.execPath;
  terminal.args = [
    "-e",
    'require("fs").writeFileSync("argv.txt",process.argv[1])',
    "literal's $(untrusted) value",
  ];
}

const request = (id, method, params) =>
  send({ jsonrpc: "2.0", id, method, params });
const finish = () =>
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
// An ACK proves dispatch, not that the actual command has written its PID markers.
const killAfterCommandReady = () => {
  const deadline = Date.now() + 5_000;
  const poll = () => {
    let ready = false;
    try {
      ready = readFileSync(join(root, "command-ready"), "utf8") === "ready\n";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ready) request("kill", "terminal/kill", { sessionId, terminalId });
    else if (Date.now() >= deadline)
      throw new Error("Actual terminal command readiness timed out");
    else setTimeout(poll, 25);
  };
  poll();
};
const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  const v = JSON.parse(text);
  log({ type: "received", message: v });
  if (v.method === "initialize")
    send({
      jsonrpc: "2.0",
      id: v.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
  else if (v.method === "session/new")
    send({ jsonrpc: "2.0", id: v.id, result: { sessionId } });
  else if (v.method === "session/prompt") {
    promptId = v.id;
    if (mode === "direct-write") request("write", "fs/write_text_file", write);
    else if (mode === "outside")
      request("write", "fs/write_text_file", {
        ...write,
        path: join(root, "../outside.txt"),
      });
    else if (mode === "wrong-session")
      request("write", "fs/write_text_file", {
        ...write,
        sessionId: "different-session",
      });
    else if (mode.startsWith("terminal"))
      request("create", "terminal/create", terminal);
    else
      request("permission", "session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "precise-write",
          name: "untrusted-name",
          title: "untrusted descriptive data",
          rawInput: { method: "fs/write_text_file", params: write },
        },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
  } else if (v.method === "session/cancel") {
    log({ type: "cancel-received" });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  } else if (v.id === "permission") {
    if (v.result?.outcome?.optionId === "once") {
      if (mode === "permission-mutate")
        request("write", "fs/write_text_file", {
          ...write,
          content: "Mutated content requires another approval.\n",
        });
      else request("write", "fs/write_text_file", write);
    } else finish();
  } else if (v.id === "write") {
    if (mode === "duplicate-write") {
      request("write", "fs/write_text_file", write);
    } else finish();
  } else if (v.id === "create") {
    if (v.result?.terminalId) {
      terminalId = v.result.terminalId;
      if (mode === "terminal-hold") return;
      if (mode === "terminal-live-wait-kill")
        setTimeout(
          () =>
            request("live-output", "terminal/output", {
              sessionId,
              terminalId,
            }),
          150,
        );
      else if (mode === "terminal-kill") killAfterCommandReady();
      else if (mode === "terminal-kill-immediate")
        request("kill", "terminal/kill", { sessionId, terminalId });
      else request("wait", "terminal/wait_for_exit", { sessionId, terminalId });
    } else finish();
  } else if (v.id === "live-output") {
    request("wait", "terminal/wait_for_exit", { sessionId, terminalId });
    setTimeout(
      () => request("kill", "terminal/kill", { sessionId, terminalId }),
      50,
    );
  } else if (
    (v.id === "wait" || v.id === "kill") &&
    mode === "terminal-live-wait-kill"
  ) {
    if (v.id === "wait") liveWait = true;
    else liveKill = true;
    if (liveWait && liveKill)
      request("release", "terminal/release", { sessionId, terminalId });
  } else if (v.id === "wait" || v.id === "kill")
    request("output", "terminal/output", { sessionId, terminalId });
  else if (v.id === "output")
    request("release", "terminal/release", { sessionId, terminalId });
  else if (v.id === "release") finish();
});
