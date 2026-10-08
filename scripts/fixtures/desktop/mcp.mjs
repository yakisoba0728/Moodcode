import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "server/discover")
    result = {
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, resources: {} },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "desktop-fixture",
          version: "1",
        },
      },
    };
  else if (request.method === "tools/list")
    result = {
      resultType: "complete",
      tools: [
        {
          name: "echo",
          description: "Desktop fixture echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    };
  else if (request.method === "resources/list")
    result = { resultType: "complete", resources: [] };
  else if (request.method === "tools/call")
    result = {
      resultType: "complete",
      content: [
        {
          type: "text",
          text: request.params.arguments.text ?? "desktop native MCP result",
        },
      ],
    };
  else {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Unknown fixture method" },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result });
});
