import { createHash, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { EngineError } from "@moodcode/contracts";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const ownPath = fileURLToPath(import.meta.url);
const official = "https://api.anthropic.com/v1";
const providerId = "verify-anthropic";
const references = Object.freeze([
  "https://platform.claude.com/docs/en/models/overview",
  "https://platform.claude.com/docs/en/build-with-claude/vision",
  "https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows",
]);
const failureCode = (error) =>
  /^[A-Z][A-Z0-9_]{0,63}$/u.test(error?.code ?? "")
    ? error.code
    : "VERIFY_ANTHROPIC_FAILED";
function requireEvidence(value, code) {
  if (!value) throw Object.assign(new Error("Anthropic verification evidence is incomplete"), { code });
}
function plainReference(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
}
async function cancelReceivedBody(response) {
  if (!response.body) return true;
  if (response.body.locked) return false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => response.body.cancel()).then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function pngChunk(name, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  out.write(name, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
/** Complete RGB pixels, zlib data and CRCs; no answer-bearing PNG metadata. */
export function anthropicColorProbe(order) {
  const rgb = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255] };
  requireEvidence(Array.isArray(order) && order.length === 3 && new Set(order).size === 3 && order.every((color) => Object.hasOwn(rgb, color)), "VERIFY_INVALID_PROBE");
  const width = 384, height = 128, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.set(rgb[order[Math.floor(x / 128)]], y * stride + x * 3 + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function assertAbsent(value, expected) {
  const visit = (item, imageData = false) => {
    if (typeof item === "string") {
      if (imageData) return;
      const words = item.toLowerCase().split(/[^a-z0-9-]+/u);
      requireEvidence(!expected.some((word) => words.includes(word)), "VERIFY_ANSWER_LEAKED");
    } else if (Array.isArray(item)) item.forEach((child) => visit(child));
    else if (item && typeof item === "object")
      Object.entries(item).forEach(([name, child]) => {
        if (item.type === "image" && name === "source" && child?.type === "base64")
          Object.entries(child).forEach(([sourceName, sourceValue]) => visit(sourceValue, sourceName === "data"));
        else visit(child);
      });
  };
  visit(value);
}
function allParts(engine, runId) {
  return engine.store.listTurns(runId).flatMap((turn) => engine.store.listParts(turn.id));
}
function nativeEvidence(engine, run, observations) {
  const attempts = observations.filter((item) => item.runId === run.id).map((item) => {
    const attempt = engine.store.getAttempt(item.attemptId);
    const cleanup = engine.store.getAttemptCleanup(item.attemptId, run.sessionId);
    for (const name of ["sessionId", "runId", "turnId", "attemptId", "providerId", "modelId", "requestSha256"])
      requireEvidence(cleanup[name] === item[name], "VERIFY_NATIVE_OWNER_MISMATCH");
    return {
      ...item, state: attempt.state,
      cleanup: { state: cleanup.state, confirmed: cleanup.cleanupConfirmed, method: cleanup.method, reason: cleanup.reason },
      usage: engine.store.getAttemptUsage(item.attemptId)?.usage ?? null,
    };
  });
  const snapshot = engine.store.getSnapshot(run.sessionId);
  return {
    sessionId: run.sessionId, runId: run.id, inputId: run.inputId,
    state: run.state, errorCode: run.error?.code ?? null,
    runSha256: digest(JSON.stringify(run)), attempts,
    tools: snapshot.tools.filter((tool) => tool.runId === run.id).map((tool) => ({
      id: tool.id, name: tool.name, state: tool.state, sha256: digest(JSON.stringify(tool)),
    })),
    parts: allParts(engine, run.id).map((part) => ({
      id: part.id, turnId: part.turnId, type: part.type, state: part.state,
      ...(part.type === "tool" ? { toolCallId: part.toolCallId, name: part.name } : {}),
      sha256: digest(JSON.stringify(part)),
    })),
    replay: snapshot.messages.filter((message) => message.runId === run.id && message.providerReplay).map((message) => ({
      messageId: message.id, providerId: message.providerReplay.providerId,
      modelId: message.providerReplay.modelId, protocol: message.providerReplay.protocol,
      version: message.providerReplay.version,
      types: message.providerReplay.items.map((item) => item.type),
      sha256: digest(JSON.stringify(message.providerReplay.items)),
    })),
  };
}
function successful(evidence, expectedAttempts) {
  requireEvidence(evidence.state === "completed", evidence.errorCode ?? "VERIFY_RUN_NONCOMPLETE");
  requireEvidence(evidence.attempts.length === expectedAttempts && evidence.attempts.every((attempt) => attempt.state === "completed" && attempt.cleanup.confirmed === true), "VERIFY_NATIVE_ATTEMPT_INCOMPLETE");
  requireEvidence(evidence.attempts.every((attempt) => Number.isSafeInteger(attempt.usage?.inputTokens) && attempt.usage.inputTokens > 0 && Number.isSafeInteger(attempt.usage?.outputTokens) && attempt.usage.outputTokens > 0), "VERIFY_USAGE_MISSING");
  requireEvidence(evidence.parts.length > 0 && evidence.parts.every((part) => part.state === "completed"), "VERIFY_NATIVE_PART_INCOMPLETE");
}

/** Host supplies auth, fixed model, actual engine/provider modules and transport. No credential discovery.
 * Account qualification belongs to the central source/runtime/transport verifier, never this callable lane.
 */
export async function verifyAnthropicCoverage(options) {
  const { api, AnthropicProvider, anthropicModelSpec, modelId, apiKey,
    fetch: transport = globalThis.fetch, baseURL = official,
    capabilityReference = references[0], thinking = "adaptive",
    maxRequests = 3, qualification = { transport: "local-fixture" } } = options;
  requireEvidence(typeof api?.createEngine === "function" && typeof api?.createReadTools === "function" && typeof AnthropicProvider === "function" && typeof anthropicModelSpec === "function", "VERIFY_RUNTIME_REQUIRED");
  requireEvidence(plainReference(modelId) && Buffer.byteLength(modelId) <= 256 && typeof transport === "function" && maxRequests === 3 && ["adaptive", "disabled"].includes(thinking), "VERIFY_INVALID_ARGUMENT");
  requireEvidence(plainReference(capabilityReference) && ["local-fixture", "real-remote"].includes(qualification.transport), "VERIFY_QUALIFICATION_INVALID");
  for (const name of ["accountReference", "sourceSha256", "runtimeSha256"])
    requireEvidence(qualification[name] === undefined || plainReference(qualification[name]), "VERIFY_QUALIFICATION_INVALID");
  const endpoint = new URL(baseURL);
  requireEvidence(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && (baseURL === official || qualification.transport === "local-fixture" && endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)), "VERIFY_ENDPOINT_INVALID");
  if (apiKey !== undefined)
    requireEvidence(typeof apiKey === "string" && apiKey.length > 0 && apiKey.length <= 4096 && !/[^\x21-\x7e]/u.test(apiKey) && !JSON.stringify({ modelId, qualification, capabilityReference }).includes(apiKey), "VERIFY_INVALID_CREDENTIAL");
  if (qualification.transport === "real-remote") {
    requireEvidence(apiKey && plainReference(qualification.accountReference) && /^[a-f0-9]{64}$/u.test(qualification.sourceSha256 ?? "") && /^[a-f0-9]{64}$/u.test(qualification.runtimeSha256 ?? ""), "VERIFY_HOST_QUALIFICATION_REQUIRED");
  }
  const source = digest(await readFile(ownPath));
  const report = {
    schemaVersion: 1, kind: "anthropic-provider-coverage", observedAt: new Date().toISOString(),
    state: "running", passed: false, accountVerified: false,
    qualification: { ...qualification, accountClaimOwner: "central-provider-coverage-verifier" },
    configuration: { modelId, providerId, thinking, publicReasoningSummary: false, maxTokens: 2048, maxRequests, capabilityReference, officialReferences: references },
    verifierSha256: source, verifierUnchanged: null, actualRequests: [],
    scopeCoverage: [], observedAttempts: [], cleanupProofs: [], cleanupConfirmed: false,
    remainingScopes: ["public-reasoning-summary-account", "cancel-account", "audio-input", "video-input", "document-input", "media-output"],
  };
  const observations = [], cleanupProofs = new Map();
  let engine, temporary, activeCase = "setup", activeOwner, activeReplay, rejectedResponse, acceptedRun, uncertain = false;
  const record = () => {
    if (!acceptedRun) return;
    const evidence = nativeEvidence(engine, engine.store.getRun(acceptedRun.id), observations);
    for (const attempt of evidence.attempts) cleanupProofs.set(attempt.attemptId, attempt.cleanup);
    const scope = report.scopeCoverage.find((item) => item.caseId === activeCase);
    if (scope) scope.native = evidence;
    else report.scopeCoverage.push({ caseId: activeCase, state: "observed", native: evidence, accountVerified: false });
    return evidence;
  };
  const nonce = "probe-" + randomUUID();
  const colors = ["red", "green", "blue"];
  for (let index = colors.length - 1; index > 0; index--) {
    const other = randomInt(index + 1); [colors[index], colors[other]] = [colors[other], colors[index]];
  }
  const image = anthropicColorProbe(colors), expectedImage = colors.join(" ");
  try {
    temporary = await realpath(await mkdtemp(join(tmpdir(), "moodcode-anthropic-coverage-")));
    const repository = join(temporary, "repository");
    await mkdir(repository); execFileSync("git", ["init", "-q", repository]);
    await writeFile(join(repository, "challenge.txt"), nonce + "\n", { mode: 0o600 });
    const captureFetch = async (url, init) => {
      requireEvidence(report.actualRequests.length < maxRequests, "VERIFY_REQUEST_BUDGET");
      requireEvidence(String(url) === baseURL + "/messages" && init?.redirect === "error" && activeOwner, "VERIFY_ENDPOINT_INVALID");
      const body = JSON.parse(String(init.body));
      requireEvidence(body.model === modelId && body.stream === true && body.max_tokens === 2048, "VERIFY_WIRE_MODEL_MISMATCH");
      if (activeCase === "text-tool-replay" && !activeReplay) assertAbsent(body, [nonce]);
      if (activeCase === "image-recognition") {
        assertAbsent(body, colors);
        const blocks = body.messages.flatMap((message) => message.content).filter((block) => block.type === "image");
        requireEvidence(blocks.length === 1 && blocks[0].source.type === "base64" && blocks[0].source.media_type === "image/png" && digest(Buffer.from(blocks[0].source.data, "base64")) === digest(image), "VERIFY_IMAGE_WIRE_MISMATCH");
      }
      let replayMatch;
      if (activeReplay) {
        const native = body.messages.find((message) => message.role === "assistant" && message.content.some((block) => block.type === "tool_use"));
        replayMatch = Boolean(native && digest(JSON.stringify(native.content)) === activeReplay);
        requireEvidence(replayMatch, "VERIFY_REPLAY_WIRE_MISMATCH");
      }
      const request = { ordinal: report.actualRequests.length + 1, caseId: activeCase, ...activeOwner, bodySha256: digest(String(init.body)), expectedAbsentFromInitialWire: !activeReplay, ...(replayMatch === undefined ? {} : { replayMatch }) };
      report.actualRequests.push(request);
      try {
        const response = await transport(url, init);
        request.status = response.status;
        let responseEndpointValid = !response.redirected;
        if (qualification.transport === "real-remote") {
          try { responseEndpointValid &&= response.url && new URL(response.url).href === baseURL + "/messages"; }
          catch { responseEndpointValid = false; }
        }
        if (!responseEndpointValid) {
          const confirmed = await cancelReceivedBody(response);
          request.rejectedBodyCleanupConfirmed = confirmed;
          rejectedResponse = { confirmed };
          if (!confirmed) uncertain = true;
          throw new EngineError(confirmed ? "VERIFY_ENDPOINT_INVALID" : "CLEANUP_UNCERTAIN", "Rejected provider response body requires confirmed cleanup");
        }
        return response;
      } catch (error) {
        request.errorCode = failureCode(error);
        // A host capture may itself own a rejected response the adapter never received.
        if (request.errorCode === "CLEANUP_UNCERTAIN") { rejectedResponse = { confirmed: false }; uncertain = true; }
        else if (request.errorCode === "VERIFY_ENDPOINT_INVALID") rejectedResponse ??= { confirmed: true };
        throw error;
      }
    };
    const adapter = new AnthropicProvider({ id: providerId, baseURL, apiKey, fetch: captureFetch, thinking, publicReasoningSummary: false, maxTokens: 2048, timeoutMs: 45000 });
    const provider = {
      id: adapter.id, inputModalities: adapter.inputModalities, replayProtocol: adapter.replayProtocol,
      retryableHttpStatuses: adapter.retryableHttpStatuses,
      async *streamTurn(request, signal) {
        const owner = engine.store.getAttemptCleanup(request.attemptId, request.sessionId);
        for (const name of ["runId", "sessionId", "turnId", "attemptId", "modelId"])
          requireEvidence(owner[name] === request[name], "VERIFY_NATIVE_OWNER_MISMATCH");
        requireEvidence(owner.providerId === providerId && owner.state === "dispatched", "VERIFY_NATIVE_OWNER_MISMATCH");
        activeOwner = Object.fromEntries(["workspaceId", "sessionId", "runId", "turnId", "attemptId", "providerId", "modelId", "requestSha256"].map((name) => [name, owner[name]]));
        observations.push({ ...activeOwner, ownerSha256: digest(JSON.stringify(activeOwner)) });
        const replay = request.messages.find((message) => message.role === "assistant" && message.toolCalls?.length)?.providerReplay;
        activeReplay = undefined;
        rejectedResponse = undefined;
        if (replay) {
          requireEvidence(replay.providerId === providerId && replay.modelId === modelId && replay.protocol === adapter.replayProtocol && replay.version === 1, "VERIFY_REPLAY_BINDING_MISMATCH");
          activeReplay = digest(JSON.stringify(replay.items));
        }
        try { for await (const event of adapter.streamTurn(request, signal)) yield event; }
        catch (error) {
          // The capture layer owns rejected responses that never reached the adapter.
          if (rejectedResponse) throw new EngineError(rejectedResponse.confirmed ? "VERIFY_ENDPOINT_INVALID" : "CLEANUP_UNCERTAIN", "Rejected provider response body requires confirmed cleanup");
          throw error;
        }
      },
    };
    engine = api.createEngine({
      dbPath: join(temporary, "engine.sqlite"), artifactDir: join(temporary, "artifacts"),
      providers: [provider], tools: api.createReadTools().filter((tool) => tool.name === "read_file"),
      modelSpecs: [anthropicModelSpec(modelId, { providerId, thinking })],
      defaults: { providerId, modelId, mode: "plan", limits: { maxTurns: 2, maxToolCalls: 1, maxContextBytes: 1048576, maxOutputBytes: 32768, maxDurationMs: 120000 }, budgets: { maxProviderAttempts: 1, providerRequestTimeoutMs: 45000, providerInactivityTimeoutMs: 15000 } },
    });
    const command = async (type, payload, native = false) => {
      const envelope = { schemaVersion: native ? 2 : 1, commandId: randomUUID(), type, payload };
      const result = await (native ? engine.dispatchSession(envelope) : engine.dispatch(envelope));
      requireEvidence(result.ok, result.error?.code ?? "VERIFY_NATIVE_COMMAND_FAILED");
      return result.result;
    };
    const workspace = await command("workspace.open", { path: repository });
    const submit = async (prompt, attachments = []) => {
      const session = await command("session.create", { workspaceId: workspace.id });
      const payload = { sessionId: session.id, requestId: randomUUID(), prompt, attachments, delivery: "queue", config: { providerId, modelId, mode: "plan", budgets: { maxProviderAttempts: 1 } } };
      const receipt = await command("input.accept", payload, true);
      await engine.scheduler.waitForSession(session.id);
      acceptedRun = await engine.coordinator.waitForRun(engine.store.getInput(receipt.inputId).runId);
      const evidence = record();
      return { receipt, payload, evidence, run: acceptedRun };
    };
    activeCase = "text-tool-replay";
    const text = await submit("Use read_file exactly once to read challenge.txt. Then respond with only the complete value on the first line, without quotes or any extra characters.");
    successful(text.evidence, 2);
    requireEvidence(text.evidence.tools.length === 1 && text.evidence.tools[0].name === "read_file" && text.evidence.tools[0].state === "completed" && text.evidence.parts.some((part) => part.type === "tool" && part.toolCallId === text.evidence.tools[0].id), "VERIFY_TOOL_NATIVE_MISMATCH");
    requireEvidence(report.actualRequests[1]?.replayMatch === true && text.evidence.replay.length === 2 && text.evidence.replay.every((item) => item.providerId === providerId && item.modelId === modelId && item.protocol === adapter.replayProtocol && item.version === 1), "VERIFY_REPLAY_NATIVE_MISSING");
    const output = (runId) => engine.store.getSnapshot(engine.store.getRun(runId).sessionId).messages.filter((message) => message.runId === runId && message.role === "assistant" && !message.toolCalls?.length).map((message) => message.content).join("");
    const actualText = output(text.run.id).trim();
    const textScope = report.scopeCoverage.at(-1);
    textScope.recognition = { matched: actualText === nonce, expectedSha256: digest(nonce), actualSha256: digest(actualText), expectedAbsentFromInitialWire: true };
    requireEvidence(actualText === nonce, "VERIFY_RECOGNITION_MISMATCH"); textScope.state = "passed";
    activeCase = "image-recognition"; acceptedRun = undefined;
    const imageSession = await command("session.create", { workspaceId: workspace.id });
    const ref = await engine.importImage(imageSession.id, image, "image/png");
    const imagePayload = { sessionId: imageSession.id, requestId: randomUUID(), prompt: "Name the colors of the three adjacent tiles in left-to-right order. Respond with only three lowercase English color names separated by single spaces.", attachments: [ref], delivery: "queue", config: { providerId, modelId, mode: "plan", budgets: { maxProviderAttempts: 1 } } };
    const imageReceipt = await command("input.accept", imagePayload, true);
    await engine.scheduler.waitForSession(imageSession.id);
    acceptedRun = await engine.coordinator.waitForRun(engine.store.getInput(imageReceipt.inputId).runId);
    const imageEvidence = record(); successful(imageEvidence, 1);
    requireEvidence(imageEvidence.tools.length === 0 && imageEvidence.parts.every((part) => part.type === "text"), "VERIFY_IMAGE_EFFECT_MISMATCH");
    const actualImage = output(acceptedRun.id).trim();
    const imageScope = report.scopeCoverage.at(-1);
    imageScope.input = { mimeType: "image/png", bytes: image.length, sha256: digest(image), width: 384, height: 128, profile: "rgb24-three-128px-tiles-v1" };
    imageScope.recognition = { matched: actualImage === expectedImage, expectedSha256: digest(expectedImage), actualSha256: digest(actualImage), expectedAbsentFromFullWire: true };
    requireEvidence(actualImage === expectedImage, "VERIFY_RECOGNITION_MISMATCH"); imageScope.state = "passed";
    activeCase = "duplicate-input"; acceptedRun = undefined;
    for (const accepted of [text, { receipt: imageReceipt, payload: imagePayload, run: engine.store.getRun(imageEvidence.runId) }]) {
      const before = nativeEvidence(engine, engine.store.getRun(accepted.run.id), observations), count = report.actualRequests.length;
      const duplicate = await command("input.accept", accepted.payload, true);
      await engine.scheduler.waitForSession(accepted.run.sessionId);
      requireEvidence(duplicate.inputId === accepted.receipt.inputId && report.actualRequests.length === count && JSON.stringify(nativeEvidence(engine, engine.store.getRun(accepted.run.id), observations)) === JSON.stringify(before), "VERIFY_DUPLICATE_REPLAYED");
      report.scopeCoverage.push({ caseId: activeCase, state: "passed", sessionId: accepted.run.sessionId, runId: accepted.run.id, inputId: duplicate.inputId, requests: 0, sameNativeIdentity: true, nativeSha256: digest(JSON.stringify(before)), accountVerified: false });
    }
    requireEvidence(report.actualRequests.length === 3, "VERIFY_REQUEST_COUNT_MISMATCH");
    report.passed = true; report.state = "passed";
  } catch (error) {
    report.failure = failureCode(error); report.failureCaseId = activeCase;
    if (acceptedRun) {
      try { const evidence = record(); if (evidence.errorCode) report.originalNativeErrorCode = evidence.errorCode; }
      catch { uncertain = true; report.evidenceFailure = "VERIFY_NATIVE_EVIDENCE_UNAVAILABLE"; }
    }
    report.state = "failed";
  } finally {
    for (const observation of observations) {
      if (cleanupProofs.has(observation.attemptId)) continue;
      try {
        const cleanup = engine.store.getAttemptCleanup(observation.attemptId, observation.sessionId);
        cleanupProofs.set(observation.attemptId, { state: cleanup.state, confirmed: cleanup.cleanupConfirmed, method: cleanup.method, reason: cleanup.reason });
      } catch { uncertain = true; report.cleanupFailure = "VERIFY_NATIVE_EVIDENCE_UNAVAILABLE"; }
    }
    try { await engine?.close(); } catch (error) { uncertain = true; report.cleanupFailure = failureCode(error); }
    if ([...cleanupProofs.values()].some((proof) => proof.confirmed !== true)) uncertain = true;
    report.observedAttempts = observations; report.cleanupProofs = [...cleanupProofs].map(([attemptId, proof]) => ({ attemptId, ...proof }));
    try { report.verifierUnchanged = digest(await readFile(ownPath)) === source; }
    catch { report.verifierUnchanged = false; }
    if (!report.verifierUnchanged) { uncertain = true; report.failure = "VERIFY_SOURCE_CHANGED"; }
    if (temporary && !uncertain) {
      try { await rm(temporary, { recursive: true, force: true }); }
      catch { uncertain = true; report.cleanupFailure = "VERIFY_FIXTURE_CLEANUP_FAILED"; }
    }
    report.cleanupConfirmed = !uncertain;
    if (temporary && uncertain) report.retainedEvidenceDirectory = temporary;
    if (uncertain) { report.passed = false; report.state = "uncertain"; }
    report.accountQualificationEligible = report.passed && report.cleanupConfirmed && qualification.transport === "real-remote";
  }
  return report;
}
