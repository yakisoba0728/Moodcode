import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@moodcode/contracts";
import type { DesktopAdvancedSnapshot } from "../shared/advanced.js";
import {
  createAdvancedStore,
  type AdvancedTransport,
} from "./advanced-store.js";

const snapshot = (sessionId: string): DesktopAdvancedSnapshot => ({
  sessionId,
  workspaceId: "workspace",
  inbox: { inputs: [], nextCursor: null },
  control: { paused: false },
  tasks: { revision: 0, tasks: [] },
  questions: [],
  terminals: [],
  terminalCapability: { available: true },
  children: [],
  worktrees: [],
  teams: [],
  workflows: { specs: [], instances: [] },
  mcp: [],
  languageServers: [],
  diagnostics: {},
});
const preview = {
  handleId: "opaque-native-handle",
  kind: "terminal.create",
  expiresAt: "2099-01-01T00:00:00Z",
  preview: {
    file: "/fixture/shell",
    args: ["-i"],
    owner: { authority: "user" },
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture() {
  const calls: Parameters<AdvancedTransport["advanced"]>[0][] = [];
  let read = async (id: string) => snapshot(id);
  let execute = async (
    _input: Parameters<AdvancedTransport["advanced"]>[0],
  ): Promise<JsonValue> => preview;
  const api: AdvancedTransport = {
    getAdvancedSnapshot: (id) => read(id),
    advanced: async (input) => {
      calls.push(structuredClone(input));
      return execute(input);
    },
  };
  return {
    store: createAdvancedStore(api),
    calls,
    read: (value: typeof read) => {
      read = value;
    },
    execute: (value: typeof execute) => {
      execute = value;
    },
  };
}

test("approval sends only the source-bound handle and explicit decision, never displayed preview JSON", async () => {
  const f = fixture();
  await f.store.bind("session-one");
  await f.store.action("terminal.preview", { file: "/fixture/shell" });
  f.execute(async () => ({
    terminal: { id: "terminal" },
    handleId: "control",
  }));
  await f.store.approve("terminal.create");
  assert.deepEqual(f.calls.at(-1), {
    sessionId: "session-one",
    type: "terminal.create",
    payload: { handleId: "opaque-native-handle", approved: true },
  });
  assert.equal(f.store.getSnapshot().preview, null);
  await f.store.dispose();
});

test("an uncertain approval result consumes the UI handle and cannot replay on another click", async () => {
  const f = fixture();
  await f.store.bind("session-one");
  await f.store.action("terminal.preview");
  f.execute(async () => {
    throw new Error("reply lost after native dispatch");
  });
  await f.store.approve("terminal.create");
  await f.store.approve("terminal.create");
  assert.equal(
    f.calls.filter((call) => call.type === "terminal.create").length,
    1,
  );
  assert.match(f.store.getSnapshot().error!, /reply lost/);
  await f.store.dispose();
});

test("session switch releases old authority and rejects its late preview", async () => {
  const f = fixture(),
    late = deferred<JsonValue>();
  await f.store.bind("session-one");
  f.execute(async (input) =>
    input.type === "terminal.preview" ? late.promise : null,
  );
  const action = f.store.action("terminal.preview");
  await f.store.bind("session-two");
  late.resolve(preview);
  await action;
  assert.equal(f.store.getSnapshot().sessionId, "session-two");
  assert.equal(f.store.getSnapshot().preview, null);
  assert.deepEqual(f.calls.at(-1), {
    sessionId: "session-one",
    type: "handle.release",
    payload: { handleId: "opaque-native-handle" },
  });
  await f.store.dispose();
});

test("a delayed snapshot cannot overwrite the selected session", async () => {
  const f = fixture(),
    late = deferred<DesktopAdvancedSnapshot>();
  f.read((id) =>
    id === "session-one" ? late.promise : Promise.resolve(snapshot(id)),
  );
  const first = f.store.bind("session-one");
  await f.store.bind("session-two");
  late.resolve(snapshot("session-one"));
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.store.getSnapshot().snapshot?.sessionId, "session-two");
  await f.store.dispose();
});

test("closing a pending preview releases its native authority exactly once", async () => {
  const f = fixture();
  await f.store.bind("session-one");
  await f.store.action("mcp.preview");
  await f.store.dismissPreview();
  await f.store.dispose();
  assert.equal(
    f.calls.filter((call) => call.type === "handle.release").length,
    1,
  );
});

test("terminal controls and mailbox captures are capabilities consumed by their panels", async () => {
  const f = fixture();
  await f.store.bind("session-one");
  f.execute(async () => ({ ...preview, kind: "terminal.control" }));
  await f.store.action("terminal.attach", {
    terminalId: "terminal",
    approved: true,
  });
  assert.equal(f.store.getSnapshot().preview, null);
  assert.equal(
    (f.store.getSnapshot().result as { kind: string }).kind,
    "terminal.control",
  );
  await f.store.dispose();
});

test("detaching releases terminal controls and mailbox pages under their original session before child cleanup", async () => {
  const f = fixture();
  await f.store.bind("session-one");
  f.execute(async (input) =>
    input.type === "terminal.attach"
      ? { ...preview, handleId: "terminal-control", kind: "terminal.control" }
      : input.type === "team.mailbox.read"
        ? { ...preview, handleId: "mailbox-page", kind: "team.mailbox.claim" }
        : null,
  );
  await f.store.action("terminal.attach", {
    terminalId: "terminal",
    approved: true,
  });
  await f.store.action("team.mailbox.read", {
    teamId: "team",
    memberId: "member",
    generation: 1,
  });
  f.store.clearResult();
  await f.store.bind(null);
  await f.store.query("handle.release", { handleId: "terminal-control" });
  await f.store.bind("session-two");
  await f.store.dispose();
  assert.deepEqual(
    f.calls.filter((call) => call.type === "handle.release"),
    [
      {
        sessionId: "session-one",
        type: "handle.release",
        payload: { handleId: "terminal-control" },
      },
      {
        sessionId: "session-one",
        type: "handle.release",
        payload: { handleId: "mailbox-page" },
      },
    ],
  );
});

test("disposing during terminal creation releases its late control without replaying admission", async () => {
  const f = fixture(),
    late = deferred<JsonValue>();
  await f.store.bind("session-one");
  f.execute(async (input) =>
    input.type === "terminal.create" ? late.promise : null,
  );
  const creation = f.store.action("terminal.create", {
    handleId: "approved-native-preview",
    approved: true,
  });
  await f.store.dispose();
  late.resolve({ terminal: { id: "terminal" }, handleId: "late-control" });
  assert.equal(await creation, null);
  assert.equal(
    f.calls.filter((call) => call.type === "terminal.create").length,
    1,
  );
  assert.deepEqual(f.calls.at(-1), {
    sessionId: "session-one",
    type: "handle.release",
    payload: { handleId: "late-control" },
  });
  assert.equal(f.store.getSnapshot().result, null);
});
