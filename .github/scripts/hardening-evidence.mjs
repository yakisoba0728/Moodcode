import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  open,
  opendir,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { preserveFollowupEvidence } from "./followup-evidence.mjs";

const HARDENING_CASES = ["native-lifecycle", "batch-deadline"];
const HARDENING_REPORT_BYTES = 2_097_152;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function ownedHardeningDirectory(directory) {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    directory !== normalize(directory) ||
    /[\u0000-\u001f\u007f]/u.test(directory)
  )
    throw new Error("Invalid hardening CLI evidence destination");
  const stat = await lstat(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(directory)) !== directory ||
    typeof process.getuid !== "function" ||
    stat.uid !== BigInt(process.getuid())
  )
    throw new Error(
      "Hardening CLI evidence destination is not its original owned directory",
    );
}
function qualification(report) {
  return {
    runtime: report.runtime ?? null,
    node: report.runtimePins?.node ?? null,
    sourceSha256: report.sourceIdentity?.sourceSha256 ?? null,
    finalSourceSha256: report.finalSourceSha256 ?? null,
    identityStable: report.identityStable ?? null,
  };
}
/** Publish the actual child report before assertions; the launcher copies after tests join. */
export async function queueHardeningCliEvidence(
  reportBytes,
  caseName,
  directory = process.env.MOODCODE_CI_HARDENING_EVIDENCE_DIR,
) {
  if (directory === undefined || directory === null) return null;
  if (
    !HARDENING_CASES.includes(caseName) ||
    typeof reportBytes !== "string" ||
    Buffer.byteLength(reportBytes) > HARDENING_REPORT_BYTES
  )
    throw new Error("Invalid hardening CLI report");
  await ownedHardeningDirectory(directory);
  const report = JSON.parse(reportBytes);
  if (
    report.schemaVersion !== 1 ||
    report.kind !== "native-pty-repeatability" ||
    report.noLive !== true ||
    typeof report.evidenceDirectory !== "string" ||
    report.reportPath !== join(report.evidenceDirectory, "report.json")
  )
    throw new Error("Invalid original hardening CLI report");
  const stem = `${caseName}-${randomUUID()}`,
    temporary = join(directory, `.${stem}.tmp`),
    published = join(directory, `${stem}.json`);
  const item = {
    schemaVersion: 1,
    caseName,
    reportBytes: Buffer.byteLength(reportBytes),
    reportSha256: sha256(reportBytes),
    sourceQualification: qualification(report),
    reportBase64: Buffer.from(reportBytes).toString("base64"),
  };
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(item) + "\n");
  } finally {
    await handle.close();
  }
  // link publishes a complete same-directory file exclusively, including concurrent writers.
  await link(temporary, published);
  await unlink(temporary);
  return published;
}
export async function preserveHardeningCliReports(directory) {
  await ownedHardeningDirectory(directory);
  const names = [],
    stream = await opendir(directory);
  let entries = 0;
  for await (const entry of stream) {
    if (++entries > 8) throw new Error("Hardening CLI evidence entry limit");
    if (
      /^\.(?:native-lifecycle|batch-deadline)-[a-f0-9-]{36}\.tmp$/.test(
        entry.name,
      )
    )
      continue;
    if (
      !/^(?:native-lifecycle|batch-deadline)-[a-f0-9-]{36}\.json$/.test(
        entry.name,
      ) ||
      names.length === 2
    )
      throw new Error("Invalid hardening CLI evidence queue");
    names.push(entry.name);
  }
  const queued = [],
    seen = new Set();
  for (const name of names.sort()) {
    const path = join(directory, name),
      selected = await lstat(path, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink())
      throw new Error("Invalid hardening CLI evidence manifest");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
    let item;
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.dev !== selected.dev ||
        before.ino !== selected.ino ||
        before.nlink !== 1n ||
        before.uid !== BigInt(process.getuid()) ||
        before.size > 3_145_728n
      )
        throw new Error("Invalid hardening CLI evidence manifest");
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          count,
          buffer.length - count,
          count,
        );
        if (!bytesRead) break;
        count += bytesRead;
        if (count === buffer.length) break;
      }
      const bytes = buffer.subarray(0, count),
        after = await handle.stat({ bigint: true });
      if (
        BigInt(bytes.length) !== before.size ||
        ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(
          (key) => before[key] !== after[key],
        )
      )
        throw new Error("Hardening CLI evidence manifest changed");
      item = JSON.parse(bytes);
    } finally {
      await handle.close();
    }
    if (
      item.schemaVersion !== 1 ||
      !HARDENING_CASES.includes(item.caseName) ||
      !name.startsWith(item.caseName + "-") ||
      seen.has(item.caseName) ||
      typeof item.reportBase64 !== "string"
    )
      throw new Error("Invalid hardening CLI evidence manifest");
    seen.add(item.caseName);
    const bytes = Buffer.from(item.reportBase64, "base64");
    if (
      bytes.toString("base64") !== item.reportBase64 ||
      bytes.length > HARDENING_REPORT_BYTES ||
      bytes.length !== item.reportBytes ||
      sha256(bytes) !== item.reportSha256
    )
      throw new Error("Hardening CLI report pin changed");
    const report = JSON.parse(bytes);
    if (
      JSON.stringify(qualification(report)) !==
      JSON.stringify(item.sourceQualification)
    )
      throw new Error("Hardening CLI source qualification changed");
    queued.push({ item, report });
  }
  const results = [];
  for (const { item, report } of queued) {
    const destination = await mkdtemp(
      join(directory, `${item.caseName}-copy-`),
    );
    try {
      const evidence = await preserveFollowupEvidence(
        "pty-repeatability",
        report,
        destination,
      );
      if (
        !evidence.sourceQualified ||
        !evidence.exactSourceCopy ||
        evidence.files.find((file) => file.path === "report.json")?.sha256 !==
          item.reportSha256
      )
        throw new Error(
          "Hardening CLI original report copy changed or unavailable",
        );
      results.push({
        caseName: item.caseName,
        reportSha256: item.reportSha256,
        sourceQualification: item.sourceQualification,
        evidence,
      });
    } catch (error) {
      results.push({
        caseName: item.caseName,
        failure: String(error.message).slice(0, 256),
        ...(error.evidence ? { evidence: error.evidence } : {}),
      });
    }
  }
  return {
    schemaVersion: 1,
    kind: "hardening-cli-fixture-evidence",
    passed: results.length === 2 && results.every((result) => !result.failure),
    results,
  };
}
