import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { InputRecord } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import type { ChildStorageRecord } from "../child-tasks/storage-binding.js";
import type {
  AgentMessage,
  TeamDeliveryRecord,
  TeamDeliveryReceipt,
  TeamMailboxCursor,
} from "./types.js";
import { failure, readDatabase, teamFixture } from "./fixtures/engine-team.js";
const here = dirname(fileURLToPath(import.meta.url)),
  loader = resolve(here, "../../../../node_modules/tsx/dist/loader.mjs"),
  childPath = join(
    here,
    `fixtures/team-crash-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  );
interface Evidence {
  boundary: string;
  pid: number;
  delivery: TeamDeliveryRecord;
  receipt: TeamDeliveryReceipt | null;
  childInputs: InputRecord[];
  childStorage: ChildStorageRecord;
  message: AgentMessage;
  cursor: TeamMailboxCursor;
}
for (const boundary of [
  "prepared",
  "dispatched",
  "input-accepted",
  "delivered",
] as const)
  test(
    `actual SIGKILL after original team ${boundary} preserves root/child input gap without replay, wake or foreign physical lock cleanup`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await teamFixture(t);
      await f.engine.close();
      const readyPath = join(f.base, "team-atomic-ready.json"),
        child = spawn(
          process.execPath,
          [
            "--import",
            loader,
            childPath,
            f.dbPath,
            f.artifactDir,
            f.workspace.id,
            f.session.id,
            boundary,
            readyPath,
          ],
          { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] },
        );
      let output = "",
        exited = false;
      child.stdout.on("data", (v) => (output += String(v)));
      child.stderr.on("data", (v) => (output += String(v)));
      const exit = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          exited = true;
          done({ code, signal });
        });
      });
      t.after(async () => {
        if (!exited) child.kill("SIGKILL");
        await exit;
      });
      const deadline = Date.now() + 12000;
      while (!existsSync(readyPath)) {
        assert.equal(exited, false, output);
        assert.ok(
          Date.now() < deadline,
          "No real durable team boundary: " + output,
        );
        await new Promise((done) => setTimeout(done, 10));
      }
      const proof = JSON.parse(readFileSync(readyPath, "utf8")) as Evidence;
      assert.equal(proof.boundary, boundary);
      assert.equal(proof.pid, child.pid);
      assert.equal(
        proof.delivery.state,
        boundary === "prepared"
          ? "prepared"
          : boundary === "delivered"
            ? "delivered"
            : "dispatched",
      );
      assert.equal(
        proof.childInputs.length,
        boundary === "input-accepted" || boundary === "delivered" ? 1 : 0,
      );
      assert.equal(proof.receipt !== null, boundary === "delivered");
      if (proof.childInputs[0]) {
        assert.equal(proof.childInputs[0].state, "pending");
        assert.equal(proof.childInputs[0].delivery, "steer");
        assert.equal(
          proof.childInputs[0].requestId,
          `team-delivery:${proof.delivery.id}`,
        );
      }
      child.kill("SIGKILL");
      assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
      const childFile = proof.childStorage.binding.physical.database.path,
        childRows = readDatabase(childFile, (db) =>
          db.prepare("SELECT * FROM session_inputs ORDER BY id").all(),
        ),
        beforeMessage = readDatabase(f.dbPath, (db) =>
          db.prepare("SELECT * FROM team_messages ORDER BY id").all(),
        ),
        beforeCoding = f.codingCounts();
      let calls = 0;
      const provider: ProviderAdapter = {
        id: "team-crash-original-provider",
        async *streamTurn() {
          calls++;
          yield { type: "finish", reason: "stop" };
        },
      };
      const reopened = createEngine({
        ...f.configuration,
        teams: true,
        providers: [provider],
      });
      f.engines.add(reopened);
      const history = reopened.getTeamDelivery(
        f.workspace.id,
        proof.delivery.id,
      );
      assert.ok(history);
      assert.equal(
        history.record.state,
        boundary === "prepared"
          ? "cancelled"
          : boundary === "delivered"
            ? "delivered"
            : "uncertain",
      );
      assert.deepEqual(history.receipt, proof.receipt);
      assert.deepEqual(history.record.page, proof.delivery.page);
      assert.deepEqual(history.record.owner, proof.delivery.owner);
      assert.equal(calls, 0);
      assert.deepEqual(
        readDatabase(childFile, (db) =>
          db.prepare("SELECT * FROM session_inputs ORDER BY id").all(),
        ),
        childRows,
      );
      assert.deepEqual(
        readDatabase(f.dbPath, (db) =>
          db.prepare("SELECT * FROM team_messages ORDER BY id").all(),
        ),
        beforeMessage,
      );
      assert.deepEqual(f.codingCounts(), beforeCoding);
      const cursor = readDatabase(
        f.dbPath,
        (db) =>
          JSON.parse(
            String(
              db
                .prepare(
                  "SELECT data FROM team_mailbox_cursors WHERE team_id=? AND member_id=? AND generation=?",
                )
                .get(
                  proof.cursor.teamId,
                  proof.cursor.memberId,
                  proof.cursor.generation,
                )!.data,
            ),
          ) as TeamMailboxCursor,
      );
      assert.equal(
        cursor.claimedSeq,
        boundary === "delivered" ? proof.message.seq : 0,
      );
      assert.equal(
        cursor.pendingDeliveryId,
        boundary === "prepared" || boundary === "delivered"
          ? null
          : proof.delivery.id,
      );
      assert.throws(
        () =>
          reopened.readAgentMailbox({
            workspaceId: f.workspace.id,
            teamId: proof.delivery.teamId,
            memberId: proof.delivery.memberId,
            generation: proof.delivery.generation,
          }),
        failure("TEAM_OWNER_UNAVAILABLE", "TEAM_OWNER_STALE"),
      );
      await reopened.close();
      assert.equal(calls, 0);
      assert.deepEqual(
        readDatabase(childFile, (db) =>
          db.prepare("SELECT * FROM session_inputs ORDER BY id").all(),
        ),
        childRows,
      );
    },
  );
