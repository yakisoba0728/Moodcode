let buffered = Buffer.alloc(0),
  length;
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write(
    Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      body,
    ]),
  );
};
function receive(request) {
  if (request.method === "initialize")
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        capabilities: { textDocumentSync: 2, positionEncoding: "utf-16" },
      },
    });
  else if (
    request.method === "textDocument/didOpen" ||
    request.method === "textDocument/didChange"
  ) {
    const doc = request.params.textDocument;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: doc.uri,
        version: doc.version,
        diagnostics: [
          {
            message: "Desktop fixture diagnostic",
            severity: 2,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      },
    });
  } else if (request.method === "shutdown")
    send({ jsonrpc: "2.0", id: request.id, result: null });
  else if (request.method === "exit") process.exit(0);
  else if (request.id !== undefined)
    send({ jsonrpc: "2.0", id: request.id, result: null });
}
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (length === undefined) {
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      length = Number(
        /Content-Length:\s*(\d+)/i.exec(
          buffered.subarray(0, end).toString(),
        )[1],
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
