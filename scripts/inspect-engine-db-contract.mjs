import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const HELP = `Usage: node scripts/inspect-engine-db-contract.mjs [options]
  --runtime compiled|source  Default compiled; source needs the absolute tsx loader
  --compare PATH             Require identical primary DB version, migrations and catalogue
  --report PATH              Save a new mode-0600 report (existing files are refused)
  --help
Uses a fresh in-memory DB. No stored user records, accounts or GUI are read.
This measures primary SQL compatibility; record/event semantics require regression tests.
`;

export function parseDatabaseContractArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = { runtime: "compiled" },
    seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i],
      value = args[i + 1];
    if (
      !["--runtime", "--compare", "--report"].includes(name) ||
      seen.has(name) ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0")
    )
      throw new Error("Invalid DB contract option");
    seen.add(name);
    if (name === "--runtime") {
      if (!["compiled", "source"].includes(value))
        throw new Error("Invalid runtime");
      options.runtime = value;
    } else options[name.slice(2)] = resolve(value);
  }
  return options;
}

export function inspectDatabaseCatalogue(database, migrations) {
  const version = Number(
    database.prepare("PRAGMA user_version").get().user_version,
  );
  if (
    !Number.isSafeInteger(version) ||
    version !== migrations.length ||
    migrations.some(
      (m, i) => m.version !== i + 1 || !/^[a-z0-9-]{1,128}$/.test(m.name),
    )
  )
    throw new Error("Invalid database migration identity");
  const objects = database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
    )
    .all()
    .map((row) => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: row.sql,
    }));
  if (!objects.length || objects.length > 1024)
    throw new Error("Invalid catalogue size");
  const identity = {
    version,
    migrations: migrations.map(({ version, name }) => ({ version, name })),
    objects,
  };
  return { ...identity, sha256: hash(identity) };
}

export function assertDatabaseContractEqual(current, baseline) {
  const identity = (record) => ({
    version: record?.version,
    migrations: record?.migrations,
    objects: record?.objects,
  });
  if (
    !baseline ||
    baseline.sha256 !== hash(identity(baseline)) ||
    current.sha256 !== hash(identity(current)) ||
    baseline.sha256 !== current.sha256
  )
    throw new Error("Primary database contract changed");
}

export async function inspectEngineDatabaseContract(runtime) {
  const directory = runtime === "source" ? "src" : "dist";
  const migrationUrl = new URL(
    `../packages/engine/${directory}/storage/migrations.${runtime === "source" ? "ts" : "js"}`,
    import.meta.url,
  );
  const { migrateDatabase, DATABASE_MIGRATIONS } = await import(
    migrationUrl.href
  );
  const bytesBefore = await readFile(migrationUrl),
    database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(database);
    const catalogue = inspectDatabaseCatalogue(database, DATABASE_MIGRATIONS);
    const integrity = database.prepare("PRAGMA integrity_check").all();
    const foreignKeyViolations = database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (
      integrity.length !== 1 ||
      integrity[0].integrity_check !== "ok" ||
      foreignKeyViolations.length
    )
      throw new Error("Primary database integrity failed");
    if (!bytesBefore.equals(await readFile(migrationUrl)))
      throw new Error("Migration module changed during inspection");
    return {
      schemaVersion: 1,
      kind: "engine-primary-db-contract",
      passed: true,
      noLive: true,
      runtime: {
        mode: runtime,
        node: process.version,
        sqlite: database.prepare("SELECT sqlite_version() AS version").get()
          .version,
      },
      moduleSha256: createHash("sha256").update(bytesBefore).digest("hex"),
      catalogue,
      scope:
        "Actual migrated primary SQL catalogue; no secondary DB, API, record/event or dependency attestation",
    };
  } finally {
    database.close();
  }
}

export async function runDatabaseContractCli(
  args,
  output = (text) => process.stdout.write(text),
) {
  let options;
  try {
    options = parseDatabaseContractArgs(args);
  } catch (error) {
    output(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    output(HELP);
    return 0;
  }
  try {
    const report = await inspectEngineDatabaseContract(options.runtime);
    if (options.compare) {
      const bytes = await readFile(options.compare);
      if (bytes.length > 2_097_152) throw new Error("Baseline exceeds 2 MiB");
      const baseline = JSON.parse(bytes.toString("utf8"));
      if (
        baseline.schemaVersion !== 1 ||
        baseline.kind !== report.kind ||
        baseline.passed !== true
      )
        throw new Error("Invalid DB contract baseline");
      assertDatabaseContractEqual(report.catalogue, baseline.catalogue);
      report.comparison = { equal: true, sha256: report.catalogue.sha256 };
    }
    const text = JSON.stringify(report, null, 2) + "\n";
    if (options.report)
      await writeFile(options.report, text, { mode: 0o600, flag: "wx" });
    output(text);
    return 0;
  } catch (error) {
    output(
      JSON.stringify({
        passed: false,
        kind: "engine-primary-db-contract",
        error: String(error.message).slice(0, 256),
      }) + "\n",
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.exitCode = await runDatabaseContractCli(process.argv.slice(2));
