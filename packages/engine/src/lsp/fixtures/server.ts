import { spawn } from "node:child_process";
type ObjectValue = Record<string, any>;
let buffered = Buffer.alloc(0);
let length: number | undefined;
let initialized = false;
let cancelled = 0;
let watched = 0;
const documents = new Map<string, ObjectValue>();
const hanging = new Set<number>();
function send(value: ObjectValue): void {
  const bytes = Buffer.from(JSON.stringify(value));
  process.stdout.write(
    Buffer.concat([
      Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`),
      bytes,
    ]),
  );
}
function reply(id: number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}
function diagnostics(uri: string, version: number, message: string): void {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      version,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 2,
          message,
        },
      ],
    },
  });
}
function receive(request: ObjectValue): void {
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize":
      reply(request.id, {
        capabilities: {
          textDocumentSync: 2,
          positionEncoding: "utf-16",
          documentFormattingProvider: true,
        },
      });
      break;
    case "initialized":
      initialized = true;
      break;
    case "textDocument/didOpen":
      documents.set(params.textDocument.uri, { ...params.textDocument });
      diagnostics(
        params.textDocument.uri,
        params.textDocument.version,
        "opened",
      );
      break;
    case "textDocument/didChange": {
      const doc = documents.get(params.textDocument.uri)!;
      doc.text = params.contentChanges[0].text;
      doc.version = params.textDocument.version;
      diagnostics(doc.uri, doc.version - 1, "stale");
      diagnostics(doc.uri, doc.version, "updated");
      break;
    }
    case "textDocument/didClose":
      documents.delete(params.textDocument.uri);
      break;
    case "workspace/didChangeWatchedFiles":
      watched++;
      break;
    case "textDocument/formatting": {
      const doc = documents.get(params.textDocument.uri)!;
      const first = (doc.text as string).split(/\r\n|\n|\r/)[0]!;
      reply(request.id, [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: first.length },
          },
          newText: first.replaceAll("bad", "good"),
        },
      ]);
      break;
    }
    case "fixture/state":
      reply(request.id, {
        initialized,
        documents: [...documents.values()],
        cancelled,
        hanging: hanging.size,
        watched,
      });
      break;
    case "fixture/hang":
      hanging.add(request.id);
      break;
    case "$/cancelRequest":
      if (hanging.delete(params.id)) cancelled++;
      break;
    case "fixture/malformed":
      process.stdout.write("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}");
      break;
    case "fixture/oversize":
      process.stdout.write("Content-Length: 1048577\r\n\r\n");
      break;
    case "fixture/descendant": {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      );
      reply(request.id, { pid: child.pid });
      break;
    }
    case "fixture/env":
      reply(request.id, {
        parentSecret: process.env.MOODCODE_LSP_FIXTURE_SECRET ?? "absent",
      });
      break;
    case "fixture/server_effect":
      send({
        jsonrpc: "2.0",
        id: "server-effect",
        method: "workspace/applyEdit",
        params: { edit: { changes: { "file:///outside": [] } } },
      });
      reply(request.id, true);
      break;
    case "shutdown":
      reply(request.id, null);
      break;
    case "exit":
      process.exit(0);
      break;
    default:
      if (request.id !== undefined && request.method) reply(request.id, null);
  }
}
process.stdin.on("data", (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (length === undefined) {
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      length = Number(
        /Content-Length:\s*(\d+)/i.exec(
          buffered.subarray(0, end).toString(),
        )![1],
      );
      buffered = buffered.subarray(end + 4);
    }
    if (buffered.length < length) return;
    const body = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    length = undefined;
    receive(JSON.parse(body.toString()));
  }
});
process.stderr.write("private fixture server log\n");
