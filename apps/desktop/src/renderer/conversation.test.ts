import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRecord } from "@moodcode/contracts";
import {
  TEXT_PAGE,
  TEXT_PREVIEW,
  MAX_COPY_BYTES,
  copyFits,
  conversationLink,
  fencedCode,
  lineLocation,
  runErrorHelp,
  textPage,
  toolOutputView,
} from "./conversation.js";

test("bounded pages preserve the exact original across UTF-8 and line boundaries", () => {
  const source = "가😀é\n".repeat(2_100) + "last😀";
  const pages: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const page = textPage(source, offset, { maxBytes: 35, maxLines: 3 });
    assert.ok(page.end > offset);
    assert.ok(Buffer.byteLength(page.text) <= 35);
    assert.ok(page.text.split("\n").length <= 4);
    assert.ok(!/[\ud800-\udbff]$/.test(page.text));
    assert.ok(!/^[\udc00-\udfff]/.test(page.text));
    pages.push(page.text);
    offset = page.end;
    assert.equal(page.hasMore, offset < source.length);
  }
  assert.equal(pages.join(""), source);
});

test("preview and expanded pages keep giant lines and many rows within DOM budgets", () => {
  const giant = "😀".repeat(50_000);
  const preview = textPage(giant, 0, TEXT_PREVIEW);
  const expanded = textPage(giant);
  assert.equal(preview.bytes, TEXT_PREVIEW.maxBytes);
  assert.equal(expanded.bytes, TEXT_PAGE.maxBytes);
  assert.equal(preview.partialLine, true);
  assert.equal(textPage("a\n".repeat(1_000), 0, TEXT_PREVIEW).lastLine, 80);
  assert.equal(textPage("a\n".repeat(1_000)).lastLine, 400);
  assert.equal(textPage("", 0).hasMore, false);
  assert.equal(textPage("", 0).text, "");
  const aligned = textPage("a😀b", 2);
  assert.equal(aligned.start, 1);
  assert.equal(aligned.text, "😀b");
});

test("file line jumps find the exact origin and bound pages without losing source", () => {
  const source = Array.from(
    { length: 10_000 },
    (_, index) => `line${index + 1}😀`,
  ).join("\n");
  const origin = lineLocation(source, 8_765);
  assert.equal(origin.line, 8_765);
  assert.equal(origin.clamped, false);
  assert.ok(source.slice(origin.offset).startsWith("line8765😀\n"));
  const page = textPage(source, origin.offset, TEXT_PREVIEW);
  assert.equal(page.firstLine, 8_765);
  assert.equal(page.lastLine, 8_844);
  assert.ok(page.bytes <= TEXT_PREVIEW.maxBytes);
  assert.ok(page.hasMore);
  assert.equal(
    source.slice(0, page.start) + page.text + source.slice(page.end),
    source,
  );
});

test("copy size checks count UTF-8 without allocating an encoded whole-file buffer", () => {
  assert.equal(copyFits("x".repeat(MAX_COPY_BYTES)), true);
  assert.equal(copyFits("x".repeat(MAX_COPY_BYTES + 1)), false);
  assert.equal(copyFits("😀".repeat(MAX_COPY_BYTES / 4)), true);
  assert.equal(copyFits("😀".repeat(MAX_COPY_BYTES / 4 + 1)), false);
  assert.equal(copyFits("\ud800".repeat(Math.floor(MAX_COPY_BYTES / 3))), true);
  assert.equal(
    copyFits("\ud800".repeat(Math.floor(MAX_COPY_BYTES / 3) + 1)),
    false,
  );
});

test("invalid and out-of-range initial lines safely use the first or final file line", () => {
  for (const line of [-1, 0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.deepEqual(lineLocation("first\nlast", line), {
      offset: 0,
      line: 1,
      requestedLine: 1,
      clamped: false,
    });
  assert.deepEqual(lineLocation("first\nlast", 30), {
    offset: 6,
    line: 2,
    requestedLine: 30,
    clamped: true,
  });
  assert.deepEqual(lineLocation("", 30), {
    offset: 0,
    line: 1,
    requestedLine: 30,
    clamped: true,
  });
  assert.deepEqual(lineLocation("one\n", 2), {
    offset: 4,
    line: 2,
    requestedLine: 2,
    clamped: false,
  });
});

test("a generated code fence cannot be closed by user code or language metadata", () => {
  const source = "```\n<script>alert(1)</script>\n````\n| x | y |";
  const fenced = fencedCode(source, "javascript");
  assert.equal(fenced.split("\n")[0], "`````javascript");
  assert.ok(fenced.includes(source));
  assert.equal(fenced.split("\n").at(-1), "`````");
  assert.equal(fencedCode("example", "js\n<script>").split("\n")[0], "```");
});

test("conversation links distinguish HTTP from bounded local file locations", () => {
  assert.deepEqual(conversationLink("https://example.com/docs?a=1#code"), {
    kind: "external",
    url: "https://example.com/docs?a=1#code",
  });
  assert.deepEqual(conversationLink("./src/a.ts#L42-L48"), {
    kind: "file",
    path: "src/a.ts",
    line: 42,
  });
  assert.deepEqual(conversationLink("src/a.ts:42:7"), {
    kind: "file",
    path: "src/a.ts",
    line: 42,
  });
  assert.deepEqual(conversationLink("/Users/me/project/file.ts:12"), {
    kind: "file",
    path: "/Users/me/project/file.ts",
    line: 12,
  });
  assert.deepEqual(conversationLink("file:///Users/me/project/file.ts#L12"), {
    kind: "file",
    path: "/Users/me/project/file.ts",
    line: 12,
  });
  assert.deepEqual(conversationLink("my%20file.md"), {
    kind: "file",
    path: "my file.md",
  });
  assert.deepEqual(conversationLink("Makefile"), {
    kind: "file",
    path: "Makefile",
  });
  assert.deepEqual(conversationLink("문서.md"), {
    kind: "file",
    path: "문서.md",
  });
  assert.deepEqual(conversationLink(".gitignore"), {
    kind: "file",
    path: ".gitignore",
  });
  assert.deepEqual(conversationLink("README", { bareFile: true }), {
    kind: "file",
    path: "README",
  });
  assert.equal(conversationLink("arbitraryLiteral"), null);
});

test("unsafe schemes, network file URLs, traversal and arbitrary fragments stay inert", () => {
  for (const source of [
    "javascript:alert(1)",
    "javascript:12",
    "data:text/html,hello",
    "command:run",
    "mailto:a@b.com",
    "javascript%3Aalert(1)",
    "//example.com/a.ts",
    "file://remote-host/private.ts",
    "file://localhost/private.ts",
    "file:///inside/../private.ts",
    "file:///inside/%252e%252e/private.ts",
    "https://user:secret@example.com/a",
    "../private.ts",
    "src/%2e%2e/private.ts",
    "src/a.ts?open=true",
    "src/a.ts#L10-L1",
    "src/a.ts#header",
    "src/a.ts:0",
    "src/a.ts#L10000001",
    "src/a.ts#L1:2",
    "src\\a.ts",
    "a.ts\u0000",
    "3.14",
    "#anchor",
  ])
    assert.equal(conversationLink(source), null, source);
  for (const source of [
    "javascript:12",
    "command:run",
    "data:12",
    "src/%2e%2e/private.ts",
  ])
    assert.equal(conversationLink(source, { bareFile: true }), null, source);
});

function tool(name: string, output: string): ToolCallRecord {
  return {
    id: "t",
    runId: "r",
    sessionId: "s",
    name,
    input: {},
    state: "completed",
    output,
  };
}

test("search locations are extracted from persisted output without changing source", () => {
  const source = JSON.stringify({
    returnedCount: 101,
    truncated: true,
    matches: Array.from({ length: 101 }, (_, index) => ({
      path: `src/a${index}.ts`,
      line: index + 1,
      text: "recorded text",
    })),
  });
  const result = toolOutputView(tool("search_files", source));
  assert.equal(result.source, source);
  assert.equal(result.truncated, true);
  assert.equal(result.references.length, 80);
  assert.deepEqual(result.references[0], {
    path: "src/a0.ts",
    line: 1,
    text: "recorded text",
  });
  assert.ok(result.notices.some((notice) => notice.includes("일부 결과")));
});

test("read/file results reject unsafe paths and invalid line metadata", () => {
  const read = toolOutputView(
    tool(
      "read_file",
      JSON.stringify({
        path: "src/a.ts",
        content: "recorded",
        startLine: 17,
        partialLastLine: true,
      }),
    ),
  );
  assert.deepEqual(read.references, [{ path: "src/a.ts", line: 17 }]);
  assert.ok(read.notices.some((notice) => notice.includes("마지막 줄")));
  const search = toolOutputView(
    tool(
      "search_files",
      JSON.stringify({
        matches: [
          { path: "../private.ts", line: 7 },
          { path: "src/a.ts", line: -1, text: "x".repeat(500) },
          { path: "src/b.ts", line: 1.5 },
        ],
      }),
    ),
  );
  assert.equal(search.references.length, 2);
  assert.equal(search.references[0]?.line, undefined);
  assert.equal(search.references[0]?.text?.length, 240);
  assert.deepEqual(
    toolOutputView(tool("run_command", "plain recorded command output"))
      .references,
    [],
  );
  assert.equal(
    toolOutputView(tool("run_command", "not JSON")).source,
    "not JSON",
  );
});

test("run error guidance preserves uncertainty and explains actual provider status codes", () => {
  const output = runErrorHelp({ code: "OUTPUT_LIMIT", message: "original" });
  assert.match(output.cause, /출력 분량/);
  assert.match(output.action, /줄 범위/);
  const uncertain = runErrorHelp({
    code: "CLEANUP_UNCERTAIN",
    message: "original",
  });
  assert.match(uncertain.action, /다시 실행하지/);
  assert.match(
    runErrorHelp({
      code: "PROVIDER_HTTP_ERROR",
      message: "Provider HTTP request failed with status 401.",
    }).cause,
    /인증/,
  );
  assert.match(
    runErrorHelp({
      code: "PROVIDER_HTTP_ERROR",
      message: "Provider HTTP request failed with status 429.",
    }).cause,
    /요청 제한/,
  );
  assert.match(
    runErrorHelp({
      code: "PROVIDER_TRANSPORT_ERROR",
      message: "Provider HTTP transport failed.",
    }).cause,
    /연결/,
  );
  assert.match(
    runErrorHelp({ code: "CODEX_AUTH_EXPIRED", message: "expired" }).action,
    /다시 로그인/,
  );
  assert.match(runErrorHelp({ code: "unknown", message: "401" }).cause, /오류/);
});
