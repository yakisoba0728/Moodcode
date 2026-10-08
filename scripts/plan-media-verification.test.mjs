import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const planner = join(root, "scripts/plan-media-verification.mjs");
/** @param {string[]} [args] @param {{imports?:string[], planner?:string, cwd?:string, env?:NodeJS.ProcessEnv}} [options] */
function run(args = [], options = {}) {
  return spawnSync(
    process.execPath,
    [
      ...(options.imports ?? []).flatMap((path) => ["--import", path]),
      options.planner ?? planner,
      ...args,
    ],
    {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 131072,
    },
  );
}
/** @param {string[]} [args] */
function plan(args = []) {
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
/** @param {import("node:test").TestContext} t */
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), "moodcode-media-plan-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** @param {import("node:test").TestContext} t @param {{sourcePins:Record<string,string>}} selected @param {string[]} args */
function guarded(t, selected, args) {
  const base = temporary(t),
    audit = join(base, "audit.json"),
    preload = join(base, "guard.mjs");
  const allowed = Object.keys(selected.sourcePins).map((path) =>
    join(root, path),
  );
  writeFileSync(
    preload,
    `
import fs from 'node:fs';
import promises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
const counts={sourceReads:[],configurationReads:0,credentialEnvironmentReads:0,providerImports:0,fetchCalls:0,networkCalls:0};
const allowed=new Set(${JSON.stringify(allowed)});
const script=${JSON.stringify(planner)};
const sourceFds=new Set();
const readable=(path)=>{
 const p=path instanceof URL?fileURLToPath(path):String(path);
 if(p===script)return p;
 if(!allowed.has(p)){counts.configurationReads++;throw new Error('Planner attempted non-source filesystem access');}
 return p;
};
const read=fs.readFileSync;
fs.readFileSync=(path,...args)=>{readable(path);return read(path,...args);};
const open=fs.openSync,readBytes=fs.readSync,close=fs.closeSync;
fs.openSync=(path,...args)=>{const p=readable(path);const fd=open(path,...args);if(allowed.has(p))counts.sourceReads.push(p);sourceFds.add(fd);return fd;};
fs.readSync=(fd,...args)=>{if(!sourceFds.has(fd)){counts.configurationReads++;throw new Error('Planner read unowned file descriptor');}return readBytes(fd,...args);};
fs.closeSync=(fd,...args)=>{sourceFds.delete(fd);return close(fd,...args);};
for(const name of ['readFile','open','createReadStream']){
 const original=fs[name];fs[name]=(path,...args)=>{readable(path);return Reflect.apply(original,fs,[path,...args]);};
}
for(const name of ['readFile','open']){
 const original=promises[name];promises[name]=(path,...args)=>{readable(path);return Reflect.apply(original,promises,[path,...args]);};
}
const network=()=>{counts.networkCalls++;throw new Error('Planner attempted network access');};
for(const module of [http,https])for(const name of ['get','request'])module[name]=network;
for(const name of ['connect','createConnection'])net[name]=network;
globalThis.fetch=()=>{counts.fetchCalls++;throw new Error('Planner attempted fetch');};
process.env=new Proxy(process.env,{get(target,key){if(typeof key==='string'&&/^(HOME|CODEX_HOME|OPENAI_API_KEY|ANTHROPIC_API_KEY|MOODCODE_API_KEY|.*_TOKEN)$/.test(key)){counts.credentialEnvironmentReads++;throw new Error('Planner attempted account environment lookup');}return Reflect.get(target,key);}});
syncBuiltinESMExports();
registerHooks({resolve(specifier,context,next){if(!specifier.startsWith('node:')&&specifier!==${JSON.stringify(pathToFileURL(planner).href)}){counts.providerImports++;throw new Error('Planner imported a runtime module');}return next(specifier,context);}});
process.once('exit',()=>fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(counts)));
`,
  );
  const result = run(args, {
    imports: [preload],
    cwd: base,
    env: {
      ...process.env,
      HOME: join(base, "unused-account-home"),
      CODEX_HOME: join(base, "unused-codex-home"),
      OPENAI_API_KEY: "unused-fixture-sentinel",
      MOODCODE_API_KEY: "unused-fixture-sentinel",
    },
  });
  const observed = JSON.parse(readFileSync(audit, "utf8"));
  return { result, observed, allowed };
}

test("default CLI keeps a finite source-pinned plan and never turns implemented engine lanes into account evidence", () => {
  const actual = plan();
  assert.equal(actual.schemaVersion, 1);
  assert.equal(actual.workItem, "MC2-16a");
  assert.deepEqual(actual.workItems, [
    "MC2-16a",
    "MC2-16b",
    "MC2-16c",
    "MC2-16d",
  ]);
  assert.equal(actual.kind, "account-media-verification-plan");
  assert.equal(actual.state, "plan-only");
  assert.equal(actual.liveProviderCalls, 0);
  assert.equal(actual.accountConfigurationRead, false);
  assert.equal(actual.accountVerified, false);
  assert.equal(actual.implementation.completionCredit, false);
  assert.equal(actual.implementation.modelSelectionGrantsCapability, false);
  assert.equal(actual.environmentDebt.state, "open");
  assert.equal(actual.matrix.length, 4);
  assert.ok(actual.cases.length >= 16 && actual.cases.length <= 32);
  assert.equal(
    new Set(actual.cases.map((/** @type {{id:string}} */ item) => item.id))
      .size,
    actual.cases.length,
  );
  for (const item of actual.cases) {
    assert.equal(item.state, "pending");
    assert.equal(item.evidence, null);
  }
  assert.ok(Object.keys(actual.sourcePins).length > 9);
  for (const [path, sha] of Object.entries(actual.sourcePins)) {
    assert.match(path, /^packages\/(engine|contracts)\/src\/.+\.ts$/u);
    assert.equal(
      sha,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    );
  }
  for (const path of actual.nextExecution.localSuites)
    assert.ok(readFileSync(join(root, path)).length > 0);
});

test("legacy exact provider/model selection reports implemented conditional Chat and Responses lanes without choosing capabilities", () => {
  for (const provider of [
    "codex",
    "openai-responses",
    "anthropic",
    "openai-compatible",
  ]) {
    const matrix = plan([
      "--model",
      "explicit-but-unverified",
      "--provider",
      provider,
    ]).matrix;
    assert.equal(matrix.length, 1);
    const entry = matrix[0];
    assert.equal(entry.providerId, provider);
    assert.equal(entry.modelId, "explicit-but-unverified");
    assert.equal(entry.accountVerified, false);
    assert.equal(entry.image.model, "unverified");
    const chat = provider === "openai-compatible",
      frames = chat || provider === "openai-responses";
    assert.equal(entry.audio.adapter !== "unsupported", chat);
    assert.equal(entry.video.adapter !== "unsupported", frames);
    assert.equal(entry.generatedMedia.adapter !== "unsupported", chat);
    assert.equal(
      entry.pdf.adapter !== "unsupported",
      provider === "openai-responses",
    );
    for (const key of ["audio", "video", "generatedMedia", "pdf", "image"])
      assert.equal(entry[key].accountVerified, false);
    assert.equal(
      entry.requiredCases.includes("audio-segment-recognition"),
      chat,
    );
    assert.equal(
      entry.requiredCases.includes("video-frame-recognition"),
      frames,
    );
    assert.equal(entry.requiredCases.includes("generated-audio-layout"), chat);
    assert.equal(
      entry.requiredCases.includes("pdf-page-recognition"),
      provider === "openai-responses",
    );
  }
  const chat = plan(["--provider", "openai-compatible"]).matrix[0];
  assert.equal(chat.modelId, null);
  assert.match(
    chat.audio.modelDeclaration,
    /audioModelIds.*mediaCapabilities.audioInput=true/u,
  );
  assert.match(
    chat.video.modelDeclaration,
    /videoModelIds.*mediaCapabilities.videoFrames=true/u,
  );
  assert.match(
    chat.generatedMedia.modelDeclaration,
    /outputAudio.modelIds.*mediaCapabilities.audioOutput=true/u,
  );
  assert.equal(chat.generatedMedia.imageGeneration, false);
  assert.equal(chat.generatedMedia.videoGeneration, false);
});

test("input and output plans retain exact current MIME/segment/layout bounds and unknown cost instead of guessed production support", () => {
  const actual = plan(),
    { segments, output, tokenCost } = actual.constraints;
  assert.deepEqual(segments.audioSampleRates, [8000, 16000, 24000, 48000]);
  assert.deepEqual(segments.audioChannels, [1, 2]);
  assert.equal(segments.sourceBytes, 524288);
  assert.equal(segments.maxIntervalMs, 10000);
  assert.equal(segments.sourceDurationMs, 30000);
  assert.equal(segments.decodedAndRepeatedWireAssets, 4);
  assert.equal(segments.decodedAndRepeatedWireBytes, 1048576);
  assert.equal(output.totalWavBytes, output.pcmBytes + output.wavHeaderBytes);
  assert.equal(output.layoutVerified, false);
  assert.equal(
    output.actualRunOutputAndNormalizedArtifactBudgetsRequired,
    true,
  );
  assert.equal(tokenCost.mediaTokens, null);
  assert.equal(tokenCost.documentTokens, null);
  assert.match(tokenCost.unknownMediaCost, /allowUnknownMediaTokenCost=true/u);
  assert.match(tokenCost.unknownPdfCost, /independent host and Responses/u);
  assert.ok(actual.constraints.unsupported.includes("image/video generation"));
  const ids = actual.cases.map((/** @type {{id:string}} */ item) => item.id);
  for (const id of [
    "native-provider-artifact",
    "partial-generation",
    "artifact-and-output-budget",
    "native-publication-sql-failure",
    "duplicate-delivery",
    "source-removal-or-change",
    "restart-and-paused-import",
    "sigkill-and-unjoined-cleanup",
  ])
    assert.ok(ids.includes(id));
  assert.match(actual.evidenceContract.success, /actual account response/u);
  assert.match(actual.nextExecution.newModalities, /E5-13 stay open/u);
});

test("actual CLI module has zero provider imports, credential/config/environment reads and fetch/network calls", (t) => {
  const selected = plan([
    "--provider",
    "openai-compatible",
    "--model",
    "no-account-model",
  ]);
  const { result, observed, allowed } = guarded(t, selected, [
    "--provider",
    "openai-compatible",
    "--model",
    "no-account-model",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), selected);
  assert.deepEqual(observed.sourceReads.sort(), allowed.sort());
  for (const field of [
    "configurationReads",
    "credentialEnvironmentReads",
    "providerImports",
    "fetchCalls",
    "networkCalls",
  ])
    assert.equal(observed[field], 0, field);
});

test("invalid legacy CLI combinations reject with zero source/account/network activity", (t) => {
  const selected = plan();
  for (const args of [
    ["--model", "model-without-provider"],
    ["--provider", "unknown"],
    ["--provider"],
    ["--provider", "codex", "--provider", "codex"],
    ["--endpoint", "https://unused.invalid"],
    ["--provider", "codex", "--model", "x".repeat(257)],
    ["--provider", "codex", "--model", "bad\nidentifier"],
  ]) {
    const { result, observed } = guarded(t, selected, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.deepEqual(observed.sourceReads, []);
    for (const field of [
      "configurationReads",
      "credentialEnvironmentReads",
      "providerImports",
      "fetchCalls",
      "networkCalls",
    ])
      assert.equal(observed[field], 0, field);
  }
  assert.equal(
    plan(["--provider", "codex", "--model", "x".repeat(256)]).matrix[0].modelId
      .length,
    256,
  );
});

test("a source revision changes its exact source pin; missing or oversized sources fail instead of emitting stale completion claims", (t) => {
  const actual = plan(),
    base = temporary(t);
  const fixturePlanner = join(base, "scripts/plan-media-verification.mjs");
  mkdirSync(dirname(fixturePlanner), { recursive: true });
  copyFileSync(planner, fixturePlanner);
  for (const path of Object.keys(actual.sourcePins)) {
    const target = join(base, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  const changed = "packages/engine/src/media/output.ts";
  writeFileSync(
    join(base, changed),
    readFileSync(join(base, changed), "utf8") +
      "\n// fixture-only source revision\n",
  );
  const next = run([], { planner: fixturePlanner, cwd: base });
  assert.equal(next.status, 0, next.stderr);
  const parsed = JSON.parse(next.stdout);
  assert.notEqual(parsed.sourcePins[changed], actual.sourcePins[changed]);
  assert.equal(parsed.implementation.completionCredit, false);
  for (const [path, sha] of Object.entries(actual.sourcePins))
    if (path !== changed) assert.equal(parsed.sourcePins[path], sha);
  writeFileSync(join(base, changed), "x".repeat(1048577));
  const oversized = run([], { planner: fixturePlanner, cwd: base });
  assert.notEqual(oversized.status, 0);
  assert.equal(oversized.stdout, "");
  assert.match(oversized.stderr, /source pin byte bound exceeded/u);
  rmSync(join(base, changed));
  const missing = run([], { planner: fixturePlanner, cwd: base });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /ENOENT/u);
  const canary = join(base, "not-an-account-file");
  writeFileSync(
    canary,
    "Unrelated file must never be read by the source planner.",
  );
  symlinkSync(canary, join(base, changed));
  const symlinked = run([], { planner: fixturePlanner, cwd: base });
  assert.notEqual(symlinked.status, 0);
  assert.equal(symlinked.stdout, "");
  assert.match(symlinked.stderr, /source pin byte bound exceeded|ELOOP/u);
});
