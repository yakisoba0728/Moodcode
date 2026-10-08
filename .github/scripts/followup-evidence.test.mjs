import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { renameSync, symlinkSync, watch, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FOLLOWUP_EVIDENCE_LIMITS,
  preserveFollowupEvidence,
} from "./followup-evidence.mjs";

const supported = ["linux", "darwin"].includes(process.platform);
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(mode = "persistent-soak") {
  const source = await realpath(
    await mkdtemp(
      join(
        tmpdir(),
        mode === "persistent-soak"
          ? "moodcode-resilience-"
          : "moodcode-pty-repeatability-",
      ),
    ),
  );
  const results = await realpath(
    await mkdtemp(join(tmpdir(), "moodcode-evidence-results-")),
  );
  const report =
    mode === "persistent-soak"
      ? {
          schemaVersion: 1,
          kind: "engine-persistent-soak",
          noLive: true,
          supported: true,
          passed: false,
          cleanup: { retainedEvidencePath: source },
        }
      : {
          schemaVersion: 1,
          kind: "native-pty-repeatability",
          noLive: true,
          status: "failed",
          evidenceDirectory: source,
        };
  return {
    source,
    results,
    report,
    async remove() {
      await Promise.all([
        rm(source, { recursive: true, force: true }),
        rm(results, { recursive: true, force: true }),
      ]);
    },
  };
}

test(
  "both modes preserve actual file bytes, nested DB/artifact/repo/case reports and failed classification",
  { skip: !supported, timeout: 30000 },
  async () => {
    for (const mode of ["persistent-soak", "pty-repeatability"]) {
      const f = await fixture(mode);
      try {
        const files = {
          "engine.sqlite": Buffer.from([0, 255, 1, 3]),
          "artifacts/output.txt": Buffer.from("actual output 한글"),
          "repository/.git/config": Buffer.from(
            "[core]\nrepositoryformatversion = 0\n",
          ),
          "cases/case-1.json": Buffer.from('{"status":"failed"}\n'),
        };
        for (const [path, value] of Object.entries(files)) {
          const parts = path.split("/");
          parts.pop();
          await mkdir(join(f.source, ...parts), { recursive: true });
          await writeFile(join(f.source, path), value);
        }
        const original = structuredClone(f.report),
          manifest = await preserveFollowupEvidence(mode, f.report, f.results);
        assert.deepEqual(f.report, original);
        assert.equal(manifest.reportOutcome, "failed");
        assert.equal(manifest.status, "preserved");
        assert.equal(
          manifest.sourceQualified && manifest.exactSourceCopy,
          true,
        );
        assert.equal(manifest.sourceDigest, manifest.copySourceDigest);
        assert.equal(manifest.sourceDigest, manifest.finalSourceDigest);
        assert.equal(manifest.files.length, 4);
        assert.equal(
          manifest.bytes,
          Object.values(files).reduce((sum, value) => sum + value.length, 0),
        );
        assert.deepEqual(
          JSON.parse(await readFile(manifest.manifestPath, "utf8")),
          manifest,
        );
        for (const file of manifest.files) {
          assert.equal(file.sha256, digest(files[file.path]));
          assert.equal(file.bytes, files[file.path].length);
          assert.deepEqual(
            await readFile(join(manifest.fixtureDirectory, file.path)),
            files[file.path],
          );
          assert.deepEqual(
            await readFile(join(f.source, file.path)),
            files[file.path],
          );
        }
        await assert.rejects(
          preserveFollowupEvidence(mode, f.report, f.results),
          (error) => error.code === "EEXIST",
        );
        assert.deepEqual(
          JSON.parse(await readFile(manifest.manifestPath, "utf8")),
          manifest,
        );
      } finally {
        await f.remove();
      }
    }
  },
);

test(
  "missing evidence is unavailable and invalid/native-unsupported reports do not read fixture bytes",
  { skip: !supported },
  async () => {
    const f = await fixture();
    try {
      const missing = await preserveFollowupEvidence(
        "persistent-soak",
        { passed: false },
        f.results,
      );
      assert.equal(missing.status, "unavailable");
      assert.equal(missing.sourceQualified, false);
      await assert.rejects(
        preserveFollowupEvidence("other", f.report, f.results),
        (error) => error.code === "EVIDENCE_MODE_INVALID",
      );
      for (const mode of ["__proto__", "constructor"])
        await assert.rejects(
          preserveFollowupEvidence(mode, {}, f.results),
          (error) => error.code === "EVIDENCE_MODE_INVALID",
        );
      await assert.rejects(
        preserveFollowupEvidence(
          "persistent-soak",
          { ...f.report, supported: false },
          f.results,
        ),
        (error) => error.code === "EVIDENCE_NATIVE_UNSUPPORTED",
      );
      await assert.rejects(
        preserveFollowupEvidence(
          "persistent-soak",
          { ...f.report, noLive: false },
          f.results,
        ),
        (error) => error.code === "EVIDENCE_REPORT_INVALID",
      );
      const report = { ...f.report, cleanup: {} };
      let reads = 0;
      Object.defineProperty(report.cleanup, "retainedEvidencePath", {
        get() {
          reads++;
          return f.source;
        },
      });
      await assert.rejects(
        preserveFollowupEvidence("persistent-soak", report, f.results),
        (error) => error.code === "EVIDENCE_REPORT_ACCESSOR",
      );
      assert.equal(reads, 0);
    } finally {
      await f.remove();
    }
  },
);

test(
  "canonical default temp prefix scope, symlinks, special files and destination escapes are rejected",
  { skip: !supported, timeout: 30000 },
  async () => {
    const f = await fixture(),
      outside = await realpath(
        await mkdtemp(join(tmpdir(), "moodcode-evidence-outside-")),
      );
    try {
      await writeFile(
        join(outside, "secret.txt"),
        "never copy this outside file",
      );
      await symlink(join(outside, "secret.txt"), join(f.source, "escape"));
      let rejected;
      await assert.rejects(
        preserveFollowupEvidence("persistent-soak", f.report, f.results),
        (error) => {
          rejected = error.evidence;
          return error.code === "EVIDENCE_UNSAFE_ENTRY";
        },
      );
      assert.equal(rejected.sourceQualified, false);
      assert.equal(rejected.exactSourceCopy, false);
      assert.deepEqual(rejected.files, []);
      assert.equal(
        await readFile(join(outside, "secret.txt"), "utf8"),
        "never copy this outside file",
      );
      const nested = join(f.source, "moodcode-resilience-ABCDEF");
      await mkdir(nested);
      await assert.rejects(
        preserveFollowupEvidence(
          "persistent-soak",
          { ...f.report, cleanup: { retainedEvidencePath: nested } },
          outside,
        ),
        (error) => error.code === "EVIDENCE_SOURCE_SCOPE",
      );
      await assert.rejects(
        preserveFollowupEvidence(
          "pty-repeatability",
          {
            schemaVersion: 1,
            kind: "native-pty-repeatability",
            noLive: true,
            evidenceDirectory: f.source,
          },
          outside,
        ),
        (error) => error.code === "EVIDENCE_SOURCE_SCOPE",
      );
      const link = join(outside, "moodcode-resilience-ABCDEF");
      await symlink(f.source, link);
      await assert.rejects(
        preserveFollowupEvidence(
          "persistent-soak",
          { ...f.report, cleanup: { retainedEvidencePath: link } },
          outside,
        ),
        (error) => error.code === "EVIDENCE_UNSAFE_ENTRY",
      );
      const unsafeResults = join(outside, "results-link");
      await symlink(f.results, unsafeResults);
      await assert.rejects(
        preserveFollowupEvidence("persistent-soak", f.report, unsafeResults),
        (error) => error.code === "EVIDENCE_DESTINATION_SCOPE",
      );
    } finally {
      await f.remove();
      await rm(outside, { recursive: true, force: true });
    }
    const fifo = await fixture();
    try {
      execFileSync("mkfifo", [join(fifo.source, "pipe")]);
      await assert.rejects(
        preserveFollowupEvidence("persistent-soak", fifo.report, fifo.results),
        (error) => error.code === "EVIDENCE_UNSAFE_ENTRY",
      );
    } finally {
      await fifo.remove();
    }
  },
);

test(
  "source mutation causally triggered by destination creation rejects and retains copied failure evidence",
  { skip: !supported, timeout: 30000 },
  async () => {
    const f = await fixture();
    let listener,
      changed = false;
    try {
      const original = Buffer.alloc(1048576, 65);
      await writeFile(join(f.source, "stable.bin"), original);
      listener = watch(f.results, { recursive: true }, (_event, name) => {
        if (!changed && name?.toString().endsWith("fixture/stable.bin")) {
          changed = true;
          writeFileSync(
            join(f.source, "stable.bin"),
            Buffer.alloc(original.length, 66),
          );
        }
      });
      let evidence;
      await assert.rejects(
        preserveFollowupEvidence("persistent-soak", f.report, f.results),
        (error) => {
          evidence = error.evidence;
          return error.code === "EVIDENCE_SOURCE_CHANGED";
        },
      );
      assert.equal(changed, true);
      assert.equal(evidence.status, "failed");
      assert.equal(evidence.sourceQualified || evidence.exactSourceCopy, false);
      assert.equal(
        (await stat(join(evidence.fixtureDirectory, "stable.bin"))).isFile(),
        true,
      );
      const saved = JSON.parse(await readFile(evidence.manifestPath, "utf8"));
      assert.equal(saved.status, "failed");
      assert.equal(saved.sourceQualified, false);
      assert.deepEqual(
        await readFile(join(f.source, "stable.bin")),
        Buffer.alloc(original.length, 66),
      );
    } finally {
      listener?.close();
      await f.remove();
    }
  },
);

test(
  "64MiB, 2048-file and 32-depth source limits reject without erasing available original evidence",
  { skip: !supported, timeout: 60000 },
  async () => {
    const byte = await fixture();
    try {
      await writeFile(join(byte.source, "oversize.bin"), "");
      await truncate(
        join(byte.source, "oversize.bin"),
        FOLLOWUP_EVIDENCE_LIMITS.bytes + 1,
      );
      await assert.rejects(
        preserveFollowupEvidence("persistent-soak", byte.report, byte.results),
        (error) => error.code === "EVIDENCE_SIZE_LIMIT",
      );
      assert.equal(
        (await stat(join(byte.source, "oversize.bin"))).size,
        FOLLOWUP_EVIDENCE_LIMITS.bytes + 1,
      );
    } finally {
      await byte.remove();
    }
    const count = await fixture();
    try {
      await Promise.all(
        Array.from({ length: FOLLOWUP_EVIDENCE_LIMITS.files + 1 }, (_, index) =>
          writeFile(
            join(count.source, `f${String(index).padStart(4, "0")}`),
            "",
          ),
        ),
      );
      await assert.rejects(
        preserveFollowupEvidence(
          "persistent-soak",
          count.report,
          count.results,
        ),
        (error) => error.code === "EVIDENCE_SIZE_LIMIT",
      );
    } finally {
      await count.remove();
    }
    const depth = await fixture();
    try {
      let path = depth.source;
      for (let level = 0; level <= FOLLOWUP_EVIDENCE_LIMITS.depth; level++) {
        path = join(path, "d");
        await mkdir(path);
      }
      await assert.rejects(
        preserveFollowupEvidence(
          "persistent-soak",
          depth.report,
          depth.results,
        ),
        (error) => error.code === "EVIDENCE_DEPTH_LIMIT",
      );
    } finally {
      await depth.remove();
    }
  },
);

test(
  "an original FD remains confined when its path is replaced with an outside symlink during copy",
  { skip: !supported, timeout: 30000 },
  async () => {
    const f = await fixture(),
      outside = await realpath(
        await mkdtemp(join(tmpdir(), "moodcode-evidence-outside-")),
      );
    let listener,
      replaced = false;
    try {
      const original = Buffer.alloc(1048576, 65),
        secret = Buffer.alloc(1048576, 90);
      await writeFile(join(f.source, "stable.bin"), original);
      await writeFile(join(outside, "outside.bin"), secret);
      listener = watch(f.results, { recursive: true }, (_event, name) => {
        if (!replaced && name?.toString().endsWith("fixture/stable.bin")) {
          replaced = true;
          renameSync(
            join(f.source, "stable.bin"),
            join(f.source, "original.bin"),
          );
          symlinkSync(
            join(outside, "outside.bin"),
            join(f.source, "stable.bin"),
          );
        }
      });
      let evidence;
      await assert.rejects(
        preserveFollowupEvidence("persistent-soak", f.report, f.results),
        (error) => {
          evidence = error.evidence;
          return ["EVIDENCE_SOURCE_CHANGED", "EVIDENCE_UNSAFE_ENTRY"].includes(
            error.code,
          );
        },
      );
      assert.equal(replaced, true);
      assert.equal(evidence.sourceQualified, false);
      const copied = await readFile(
        join(evidence.fixtureDirectory, "stable.bin"),
      );
      assert.deepEqual(copied, original.subarray(0, copied.length));
      assert.notDeepEqual(copied, secret);
      assert.deepEqual(await readFile(join(outside, "outside.bin")), secret);
    } finally {
      listener?.close();
      await f.remove();
      await rm(outside, { recursive: true, force: true });
    }
  },
);
