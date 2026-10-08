import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fixture, quote, until } from "./fixtures/engine.js";
import { McpClient } from "../mcp/client.js";
import { StdioMcpTransport } from "../mcp/stdio.js";
import { HttpMcpTransport } from "../mcp/http.js";
import type { ProviderAdapter } from "../ports.js";
import { createServer } from "node:http";
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };
const peer = (
  outside: string,
  root: string,
  networkUrl: string | null = null,
) =>
  `import{createInterface}from'node:readline';import{readFileSync,writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';const lines=createInterface({input:process.stdin});lines.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{},resources:{}},serverInfo:{name:'actual-sandbox',version:'1'}};else if(r.method==='tools/list')result={resultType:'complete',tools:[{name:'probe',description:'actual constrained server',inputSchema:{type:'object'}}]};else if(r.method==='resources/list')result={resultType:'complete',resources:[]};else if(r.method==='tools/call'){let outsideDenied=false,writeDenied=false,descendantDenied=false;try{readFileSync(${JSON.stringify(join(outside, "secret"))})}catch(e){outsideDenied=e.code==='EPERM'}try{writeFileSync(${JSON.stringify(join(root, "mcp-write"))},'forbidden')}catch(e){writeDenied=e.code==='EPERM'}try{execFileSync('/bin/cat',[${JSON.stringify(join(outside, "secret"))}],{stdio:'pipe'})}catch(e){descendantDenied=e.status!==0}let networkDenied=false;const networkUrl=${JSON.stringify(networkUrl)};if(networkUrl)try{execFileSync('/usr/bin/curl',['--silent','--max-time','1',networkUrl],{stdio:'pipe'})}catch(e){networkDenied=e.status!==0}result={resultType:'complete',content:[{type:'text',text:JSON.stringify({outsideDenied,writeDenied,descendantDenied,networkDenied,pid:process.pid})}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`;
test(
  "genuine sandbox stdio MCP denies file/descendant writes and close proves real group gone",
  darwin,
  async (t) => {
    const f = await fixture(t);
    const script = join(f.root, "mcp.mjs");
    writeFileSync(script, peer(f.outside, f.root));
    await f.grant();
    const { client, connected } = await f.engine.connectSandboxedMcp({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      id: "sandbox_stdio",
      command: process.execPath,
      args: [script],
      sourceFiles: [script],
    });
    assert.ok(connected.toolNames.length);
    await f.grant();
    f.engine.bindSandboxedMcp(client);
    const result = await client.callTool(
      "probe",
      {},
      client.revision,
      new AbortController().signal,
    );
    const evidence = JSON.parse(
      (result.content as { type: string; text: string }[])[0]!.text,
    );
    assert.equal(evidence.outsideDenied, true);
    assert.equal(evidence.writeDenied, true);
    assert.equal(evidence.descendantDenied, true);
    assert.equal(existsSync(join(f.root, "mcp-write")), false);
    await f.engine.disconnectMcp(client.id);
    const r = f.engine
      .observeEnforcement(f.workspace.id)
      .find((r) => r.kind === "mcp")!;
    assert.equal(r.groupPid, evidence.pid);
    assert.equal(r.state, "closed");
    assert.equal((r.completion!.outcome as any).cleanupConfirmed, true);
    assert.throws(() => process.kill(evidence.pid, 0));
  },
);
test(
  "HTTP/custom stdio MCP is denied before any startup and imported DTO cannot brand runtime transport",
  darwin,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const script = join(f.root, "unsandboxed.mjs");
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(join(f.root, "unsafe-start"))},'forbidden');setInterval(()=>{},1000);`,
    );
    const stdio = new McpClient({
      id: "unsafe_stdio",
      transport: new StdioMcpTransport({
        command: process.execPath,
        args: [script],
        cwd: f.root,
      }),
    });
    await assert.rejects(f.engine.connectMcp(stdio));
    assert.equal(existsSync(join(f.root, "unsafe-start")), false);
    const http = new McpClient({
      id: "unsafe_http",
      transport: new HttpMcpTransport({ url: "http://127.0.0.1:1/mcp" }),
    });
    await assert.rejects(f.engine.connectMcp(http));
    assert.equal(http.connected, false);
  },
);
test(
  "actual isolated child engine receives narrower OS scope and cannot read parent/outside paths",
  darwin,
  async (t) => {
    let outsideSecret = "";
    let parentStarted = false;
    let end!: () => void;
    const held = new Promise<void>((r) => (end = r));
    const seen = new Set<string>();
    const provider: ProviderAdapter = {
      id: "sandbox-fixture",
      async *streamTurn(request, signal) {
        if (
          request.messages.some(
            (m) =>
              m.role === "user" && m.content.includes("actual isolated child"),
          )
        ) {
          if (!seen.has(request.runId)) {
            seen.add(request.runId);
            yield {
              type: "tool.call",
              call: {
                id: "child-command",
                name: "run_command",
                input: {
                  command: `cat ${quote(outsideSecret)}; printf inherited > child-effect`,
                },
              },
            };
            yield { type: "finish", reason: "tool_calls" };
          } else {
            yield {
              type: "text.delta",
              delta:
                request.messages.filter((m) => m.role === "tool").at(-1)
                  ?.content ?? "NO_TOOL",
            };
            yield { type: "finish", reason: "stop" };
          }
        } else {
          parentStarted = true;
          await Promise.race([
            held,
            new Promise<void>((r) =>
              signal.addEventListener("abort", () => r(), { once: true }),
            ),
          ]);
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const f = await fixture(t, { providers: [provider] });
    outsideSecret = join(f.outside, "secret");
    f.config.limits.maxTurns = 4;
    f.config.budgets!.turnAllowance = 4;
    await f.grant();
    const worktree = await f.engine.createWorktree(
      f.session.id,
      "actual-child-tree",
    );
    const parent = await f.submit("unused parent");
    await until(() => parentStarted, "parent actual provider missing");
    const task = await f.engine.startChildTask({
      sessionId: f.session.id,
      requestId: "actual-sandbox-child",
      parentRunId: parent.runId,
      worktreeId: worktree.id,
      prompt: "actual isolated child",
      tools: ["run_command"],
      allocation: {
        turns: 2,
        toolCalls: 1,
        outputBytes: 8192,
        durationMs: 10000,
      },
    });
    await until(
      () => f.engine.children.approvals(f.session.id, task.id).length > 0,
      "child native command approval",
    );
    const a = f.engine.children.approvals(f.session.id, task.id)[0]!;
    f.engine.children.decide(
      f.session.id,
      task.id,
      a.id,
      a.fingerprint,
      "allow",
    );
    await until(() => {
      const taskNow = f.engine.children.tasks.get(f.session.id, task.id);
      return ["completed", "failed", "cancelled", "uncertain"].includes(
        taskNow.state,
      );
    }, "child physical completion");
    const actual = f.engine.children.tasks.get(f.session.id, task.id);
    assert.equal(actual.state, "completed");
    assert.ok(
      existsSync(join(worktree.root, "child-effect")),
      JSON.stringify(actual),
    );
    assert.equal(
      readFileSync(join(worktree.root, "child-effect"), "utf8"),
      "inherited",
    );
    assert.match(JSON.stringify(actual.outcome), /Operation not permitted/);
    end();
    await f.wait(parent);
  },
);

test(
  "actual provider consumes approved stdio MCP Tool/Part under the original kernel restriction",
  darwin,
  async (t) => {
    const seen = new Set<string>();
    const provider: ProviderAdapter = {
      id: "sandbox-fixture",
      async *streamTurn(request) {
        if (!seen.has(request.runId)) {
          seen.add(request.runId);
          yield {
            type: "tool.call",
            call: {
              id: "actual-mcp-read",
              name: "mcp_sandbox_model_probe",
              input: {},
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield {
            type: "text.delta",
            delta:
              request.messages.filter((m) => m.role === "tool").at(-1)
                ?.content ?? "missing native result",
          };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const f = await fixture(t, { providers: [provider] });
    let accepted = 0;
    const server = createServer((_req, res) => {
      accepted++;
      res.end("forbidden");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;
    const script = join(f.root, "model-mcp.mjs");
    writeFileSync(script, peer(f.outside, f.root, `http://127.0.0.1:${port}`));
    await f.grant();
    const { client } = await f.engine.connectSandboxedMcp({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      id: "sandbox_model",
      command: process.execPath,
      args: [script],
      sourceFiles: [script],
    });
    await f.grant();
    f.engine.bindSandboxedMcp(client);
    const r = await f.submit("actual MCP"),
      a = await f.approval(r);
    f.engine.approvals.decide(a.id, "allow", a.fingerprint);
    assert.equal((await f.wait(r)).state, "completed");
    const tool = f.engine.store.getToolCall(a.toolCallId);
    assert.equal(tool.state, "completed");
    assert.match(tool.output!, /outsideDenied\\?"?:true/);
    assert.match(tool.output!, /writeDenied\\?"?:true/);
    assert.match(tool.output!, /networkDenied\\?"?:true/);
    assert.equal(accepted, 0);
    assert.equal(existsSync(join(f.root, "mcp-write")), false);
    assert.ok(
      f.engine.store
        .listTurns(r.runId)
        .flatMap((turn) => f.engine.store.listParts(turn.id))
        .some((p) => p.type === "tool" && p.toolCallId === tool.id),
    );
    await f.engine.disconnectMcp(client.id);
    const record = f.engine
      .observeEnforcement(f.workspace.id)
      .find((r) => r.kind === "mcp")!;
    assert.equal(record.state, "closed");
    assert.equal((record.completion!.outcome as any).cleanupConfirmed, true);
  },
);

test(
  "MCP single Original catalogue binding denies unbound and replaced exact grants before actual RPC pipe write",
  darwin,
  async (t) => {
    const f = await fixture(t),
      script = join(f.root, "bound-mcp.mjs");
    writeFileSync(script, peer(f.outside, f.root));
    await f.grant();
    const { client } = await f.engine.connectSandboxedMcp({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      id: "bound_stdio",
      command: process.execPath,
      args: [script],
      sourceFiles: [script],
    });
    const transport = Reflect.get(Reflect.get(client, "options"), "transport"),
      input = Reflect.get(transport, "child").stdin,
      originalWrite = input.write;
    let delivered = 0;
    Reflect.set(input, "write", function (this: unknown, ...args: unknown[]) {
      const body = String(args[0]);
      if (body.includes('"method":"tools/call"')) delivered++;
      return Reflect.apply(originalWrite, this, args);
    });
    await assert.rejects(
      client.callTool(
        "probe",
        {},
        client.revision,
        new AbortController().signal,
      ),
      { code: "SANDBOX_MCP_UNBOUND" },
    );
    assert.equal(delivered, 0);
    await f.grant();
    assert.throws(() => f.engine.bindSandboxedMcp({ ...client }), {
      code: "SANDBOX_ORIGINAL_REQUIRED",
    });
    const binding = f.engine.bindSandboxedMcp(client);
    assert.equal(binding.kind, "mcp-binding");
    assert.equal(
      binding.groupPid,
      f.engine.observeEnforcement(f.workspace.id).find((r) => r.kind === "mcp")!
        .groupPid,
    );
    await client.callTool(
      "probe",
      {},
      client.revision,
      new AbortController().signal,
    );
    assert.equal(delivered, 1);
    await f.grant();
    await assert.rejects(
      client.callTool(
        "probe",
        {},
        client.revision,
        new AbortController().signal,
      ),
      { code: "SANDBOX_MCP_GRANT_STALE" },
    );
    assert.equal(delivered, 1);
    assert.throws(() => f.engine.bindSandboxedMcp(client), {
      code: "SANDBOX_MCP_ALREADY_BOUND",
    });
    await f.engine.disconnectMcp(client.id);
    assert.equal(
      f.engine.observeEnforcement(f.workspace.id).find((r) => r.kind === "mcp")!
        .state,
      "closed",
    );
  },
);
