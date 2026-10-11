import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { types } from "node:util";
import type { RunConfig, JsonObject } from "@moodcode/contracts";
import { EngineError } from "@moodcode/contracts";
import {
  normalizeAcceptInput,
  normalizeEngineBudgets,
} from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { TurnRequest } from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { readStableFile } from "../shared/fs.js";
import type { ToolCatalogue } from "../tools/runtime/index.js";
import type {
  AgentBackendCredentialReference,
  AgentBackendLaunch,
  AgentBackendSpec,
  AgentBackendTargetPin,
} from "./types.js";
import {
  AGENT_BACKEND_LIMITS,
  agentBackendJson,
  agentBackendObject,
  agentBackendIdentifier,
  agentBackendSigned,
  validateAgentBackendLaunch,
  validateAgentBackendSpec,
  validateAgentBackendTarget,
} from "./validation.js";
import type {
  AgentBackendRevision,
  AgentBackendStorage,
  BackendTargetProof,
  BackendTurnProof,
} from "./store.js";
import type {
  BackendLaunchPort,
  BackendLaunchProof,
  BackendConnectionProof,
} from "./process.js";
import type { BackendNativeClientEffectPort } from "./client-effects.js";

interface FilePin {
  readonly path: string;
  readonly bytes: number;
  readonly dev: string;
  readonly ino: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly sha256: string;
}
interface Target {
  readonly pin: AgentBackendTargetPin;
  readonly binding: KnowledgeHostBinding;
  readonly catalogue: ToolCatalogue;
  readonly launch: AgentBackendLaunch;
  readonly credentialReference: AgentBackendCredentialReference | null;
  readonly endpointAudience: string;
  readonly files: readonly FilePin[];
  readonly proof: BackendTargetProof;
  readonly contextOwner: "engine" | "agent";
  readonly sessionLoad: import("./types.js").AgentBackendSessionLoad | null;
}
export interface CaptureAgentBackendTarget {
  readonly backendId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly config: RunConfig;
  readonly launch: AgentBackendLaunch;
  readonly credentialReference: AgentBackendCredentialReference | null;
  readonly endpointAudience: string;
  readonly contextOwner?: "engine" | "agent";
  readonly sessionLoad?: import("./types.js").AgentBackendSessionLoad;
}
export interface AgentBackendSecretResolver {
  resolve(
    reference: AgentBackendCredentialReference,
    scope: {
      readonly workspaceId: string;
      readonly backendId: string;
      readonly audience: string;
    },
  ): string;
}
function fail(code: string): never {
  throw new EngineError(
    code,
    "Agent backend authority requires the actual root, fixed launch files and original native provider Attempt",
  );
}
function signed<T extends object>(body: T): T & { sha256: string } {
  return agentBackendSigned(body, AGENT_BACKEND_LIMITS.frameBytes);
}
function sameFile(pin: FilePin, info: BigIntStats): boolean {
  return (
    info.isFile() &&
    pin.bytes === Number(info.size) &&
    pin.dev === String(info.dev) &&
    pin.ino === String(info.ino) &&
    pin.mtimeNs === String(info.mtimeNs) &&
    pin.ctimeNs === String(info.ctimeNs)
  );
}
function captureFile(path: string, cap: number): FilePin {
  const { stats, bytes, sha256 } = readStableFile(path, {
    maxBytes: cap,
    stable: ["size", "mtime", "ctime"],
    onUnsafe: () => fail("BACKEND_LAUNCH_SOURCE_INVALID"),
    onChanged: () => fail("BACKEND_LAUNCH_SOURCE_STALE"),
    onLimit: () => fail("BACKEND_LAUNCH_SOURCE_LIMIT"),
  });
  return {
    path,
    bytes,
    dev: String(stats.dev),
    ino: String(stats.ino),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
    sha256,
  };
}

/** Only this actual Engine can bind launch/configuration data to a provider Attempt. */
export class EngineAgentBackendProducer implements BackendLaunchPort {
  private readonly epoch = randomUUID();
  private readonly targets = new WeakMap<object, Target>();
  private readonly retained = new Set<object>();
  private readonly registrations = new Map<
    string,
    { target: Target; record: AgentBackendRevision }
  >();
  private readonly turns = new WeakMap<
    object,
    {
      proof: BackendTurnProof;
      registration: { target: Target; record: AgentBackendRevision };
    }
  >();
  private readonly launches = new WeakMap<
    object,
    {
      request: TurnRequest;
      target: Target;
      spec: AgentBackendSpec;
      revisionId: string;
      proof: BackendLaunchProof;
    }
  >();
  private readonly consumedLaunches = new WeakSet<object>();
  private readonly launchOwners = new Map<
    string,
    { request: WeakRef<TurnRequest>; proof: BackendLaunchProof }
  >();
  private readonly admittedConnections = new WeakMap<object, string>();
  private closed = false;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly checkBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
    private readonly native: () => AgentBackendStorage,
    private readonly isClosing: () => boolean,
    private readonly isEnabled: () => boolean,
    private readonly executionLockPath: string,
    private readonly secrets?: AgentBackendSecretResolver,
    private readonly clientEffectsEnabled: () => boolean = () => false,
    private readonly terminalEffectsEnabled: () => boolean = () => false,
  ) {}
  private open(): void {
    if (this.closed || this.isClosing()) fail("ENGINE_CLOSED");
  }
  private enabled(): void {
    this.open();
    if (!this.isEnabled()) fail("AGENT_BACKENDS_DISABLED");
  }
  private original<T>(map: WeakMap<object, T>, original: object): T {
    this.open();
    if (!original || typeof original !== "object" || types.isProxy(original))
      fail("BACKEND_ORIGINAL_REQUIRED");
    const captured = map.get(original);
    if (!captured) fail("BACKEND_ORIGINAL_REQUIRED");
    return captured;
  }
  private issue<T>(map: WeakMap<object, T>, value: T): object {
    this.open();
    if (this.retained.size >= 128) fail("BACKEND_HANDLE_LIMIT");
    const original = Object.freeze({});
    map.set(original, value);
    this.retained.add(original);
    return original;
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    const binding = agentBackendJson(this.checkBinding(workspaceId));
    assertPhysicalKnowledgeRoot(binding);
    return binding;
  }
  private assertBinding(expected: KnowledgeHostBinding): void {
    if (
      knowledgeHash(this.binding(expected.workspaceId)) !==
      knowledgeHash(expected)
    )
      fail("BACKEND_ROOT_STALE");
  }
  private capabilities(providerId: string): string {
    return knowledgeHash(this.capabilitiesManifest(providerId));
  }
  private capabilitiesManifest(providerId: string): JsonObject {
    const capabilities = this.engine.getCapabilities();
    return agentBackendJson({
      ...capabilities,
      providerIds: [
        ...new Set([...capabilities.providerIds, providerId]),
      ].sort(),
    }) as unknown as JsonObject;
  }
  private describe(
    workspaceId: string,
    sessionId: string,
    config: RunConfig,
  ): {
    pin: AgentBackendTargetPin;
    binding: KnowledgeHostBinding;
    catalogue: ToolCatalogue;
  } {
    config = { ...config, budgets: normalizeEngineBudgets(config.budgets) };
    const binding = this.binding(workspaceId);
    if (this.engine.store.getSession(sessionId).workspaceId !== workspaceId)
      fail("BACKEND_TARGET_STALE");
    const profile = this.engine.profiles.forRun(sessionId, config);
    if (
      profile &&
      !this.engine.profiles
        .list()
        .some(
          (item) =>
            item.id === profile.id && item.revision === profile.revision,
        )
    )
      fail("BACKEND_PROFILE_STALE");
    const profilePin = profile
      ? { id: profile.id, revision: profile.revision }
      : null;
    const exposed = this.engine
        .getCapabilities()
        .tools.map((tool) => tool.name),
      allowed = profile?.tools
        ? exposed.filter((name) => profile.tools!.includes(name))
        : exposed;
    const catalogue = this.engine.toolRuntime.catalogue(
      "engine",
      config.mode,
      allowed,
      profilePin ?? undefined,
    );
    const pin = validateAgentBackendTarget({
      workspaceId,
      sessionId,
      workspaceBindingSha256: knowledgeHash(binding),
      capabilitiesSha256: this.capabilities(config.providerId),
      catalogueSha256: knowledgeHash(catalogue),
      profile: profilePin,
      config,
      runConfigSha256: knowledgeHash(config),
      tools: catalogue.tools.map((tool) => tool.name).sort(),
      allocation: {
        maxTurns: config.limits.maxTurns,
        maxToolCalls: config.limits.maxToolCalls,
        maxOutputBytes: config.limits.maxOutputBytes,
        maxDurationMs: config.limits.maxDurationMs,
      },
    });
    return { pin, binding, catalogue };
  }
  captureTarget(value: CaptureAgentBackendTarget): object {
    this.enabled();
    const input = agentBackendObject(
      value,
      [
        "backendId",
        "workspaceId",
        "sessionId",
        "config",
        "launch",
        "credentialReference",
        "endpointAudience",
      ],
      ["contextOwner", "sessionLoad"],
    );
    const backendId = agentBackendIdentifier(input.backendId),
      workspaceId = agentBackendIdentifier(input.workspaceId),
      sessionId = agentBackendIdentifier(input.sessionId);
    const existing = this.registrations.get(backendId);
    if (existing && existing.record.workspaceId !== workspaceId)
      fail("BACKEND_PROVIDER_ID_CONFLICT");
    const normalized = normalizeAcceptInput({
      sessionId,
      requestId: "backend-capture",
      prompt: "backend-capture",
      config: input.config,
      delivery: "queue",
    });
    this.binding(workspaceId);
    if (this.engine.store.getSession(sessionId).workspaceId !== workspaceId)
      fail("BACKEND_TARGET_STALE");
    normalized.config = this.engine.profiles.apply(
      sessionId,
      normalized.config,
    );
    if (normalized.config.providerId !== `acp:${backendId}`)
      fail("AGENT_BACKEND_PROVIDER_MISMATCH");
    const described = this.describe(workspaceId, sessionId, normalized.config),
      launch = validateAgentBackendLaunch(input.launch);
    const spec = validateAgentBackendSpec({
      schemaVersion: 1,
      id: backendId,
      description: "",
      protocol: "acp",
      protocolVersion: 1,
      contextOwner: input.contextOwner ?? "engine",
      ...(input.sessionLoad === undefined
        ? {}
        : { sessionLoad: input.sessionLoad }),
      launch,
      credentialReference: input.credentialReference,
      endpointAudience: input.endpointAudience,
      target: described.pin,
    });
    if (
      realpathSync(launch.cwd) !== described.binding.root ||
      launch.cwd !== described.binding.root
    )
      fail("BACKEND_LAUNCH_SCOPE_INVALID");
    const files = [
      captureFile(launch.command, 512 * 1024 * 1024),
      ...launch.sourceFiles.map((path) => captureFile(path, 8 * 1024 * 1024)),
    ];
    if (
      files.slice(1).reduce((sum, file) => sum + file.bytes, 0) >
      32 * 1024 * 1024
    )
      fail("BACKEND_LAUNCH_SOURCE_LIMIT");
    const launchSha256 = knowledgeHash({
      launch,
      files,
      credentialReference: spec.credentialReference,
      endpointAudience: spec.endpointAudience,
    });
    const proof = signed({
      workspaceId,
      backendId,
      target: described.pin,
      launchSha256,
      rootBindingSha256: knowledgeHash(described.binding),
      ownerEpoch: knowledgeHash({
        epoch: this.epoch,
        binding: described.binding,
      }),
      capabilitiesManifest: JSON.stringify(
        this.capabilitiesManifest(normalized.config.providerId),
      ),
    });
    if (spec.sessionLoad) {
      if (this.registrations.has(backendId)) fail("BACKEND_LOAD_ALIAS_USED");
      this.native().assertSessionLoadSource(spec, proof);
    }
    return this.issue(this.targets, {
      ...described,
      launch,
      credentialReference: spec.credentialReference,
      endpointAudience: spec.endpointAudience,
      files,
      proof,
      contextOwner: spec.contextOwner,
      sessionLoad: spec.sessionLoad ?? null,
    });
  }
  readTarget(original: object): BackendTargetProof {
    return agentBackendJson(this.original(this.targets, original).proof);
  }
  readTargetPin(original: object): AgentBackendTargetPin {
    return agentBackendJson(this.original(this.targets, original).pin);
  }
  private assertFiles(target: Target): void {
    this.assertBinding(target.binding);
    for (const file of target.files)
      if (
        realpathSync(file.path) !== file.path ||
        !sameFile(file, lstatSync(file.path, { bigint: true }))
      )
        fail("BACKEND_LAUNCH_SOURCE_STALE");
  }
  private assertTarget(target: Target, spec: AgentBackendSpec): void {
    this.assertFiles(target);
    const current = this.describe(
      target.pin.workspaceId,
      target.pin.sessionId,
      target.pin.config,
    );
    if (
      knowledgeHash(current.pin) !== knowledgeHash(target.pin) ||
      knowledgeHash(spec.target) !== knowledgeHash(target.pin) ||
      spec.id !== target.proof.backendId ||
      knowledgeHash(spec.launch) !== knowledgeHash(target.launch) ||
      knowledgeHash(spec.credentialReference) !==
        knowledgeHash(target.credentialReference) ||
      spec.endpointAudience !== target.endpointAudience ||
      spec.contextOwner !== target.contextOwner ||
      knowledgeHash(spec.sessionLoad ?? null) !==
        knowledgeHash(target.sessionLoad)
    )
      fail("BACKEND_TARGET_STALE");
    this.engine.toolRuntime.assertCatalogueCurrent(target.catalogue);
    if (spec.sessionLoad)
      this.native().assertSessionLoadSource(spec, target.proof);
  }
  assertTargetCurrent(
    original: object,
    proof: BackendTargetProof,
    spec: AgentBackendSpec,
  ): void {
    this.enabled();
    const target = this.original(this.targets, original);
    if (knowledgeHash(proof) !== knowledgeHash(target.proof))
      fail("BACKEND_TARGET_STALE");
    this.assertTarget(target, spec);
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(proof.workspaceId);
  }
  activate(record: AgentBackendRevision, original: object): void {
    const target = this.original(this.targets, original);
    this.assertTargetCurrent(original, target.proof, record.spec);
    if (
      !record.enabled ||
      record.target.launchSha256 !== target.proof.launchSha256
    )
      fail("BACKEND_TARGET_STALE");
    this.registrations.set(record.backendId, {
      target,
      record: agentBackendJson(record),
    });
  }
  readOwner(original: object): BackendTurnProof {
    if (this.closed) fail("ENGINE_CLOSED");
    const request = original as TurnRequest;
    const native = this.engine.coordinator.readProviderRequestOwner(request);
    const retained = this.turns.get(original);
    const registration =
      retained?.registration ??
      this.registrations.get(native.providerId.slice("acp:".length));
    if (
      !native.providerId.startsWith("acp:") ||
      !registration ||
      registration.record.workspaceId !== native.workspaceId
    )
      fail("BACKEND_OWNER_INVALID");
    const body = {
      ...native,
      rootBindingSha256: knowledgeHash(registration.target.binding),
      ownerEpoch: registration.target.proof.ownerEpoch,
    };
    const proof = signed(body);
    if (retained && retained.proof.sha256 !== proof.sha256)
      fail("BACKEND_OWNER_STALE");
    this.turns.set(original, { proof, registration });
    return agentBackendJson(proof);
  }
  readCurrentInput(original: object): {
    readonly prompt: string;
    readonly instructions: readonly string[];
  } {
    const owner = this.readOwner(original);
    this.assertOwnerCurrent(original, owner, "dispatch");
    const run = this.engine.store.getRun(owner.runId);
    if (
      run.workspaceId !== owner.workspaceId ||
      run.sessionId !== owner.sessionId
    )
      fail("BACKEND_OWNER_INVALID");
    const request = original as TurnRequest;
    return agentBackendJson({
      prompt: run.prompt,
      instructions: request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content),
    });
  }
  assertOwnerCurrent(
    original: object,
    proof: BackendTurnProof,
    phase: "dispatch" | "observe",
  ): void {
    const request = original as TurnRequest,
      captured = this.turns.get(original);
    if (!captured || knowledgeHash(proof) !== knowledgeHash(captured.proof))
      fail("BACKEND_ORIGINAL_REQUIRED");
    this.engine.coordinator.assertProviderRequest(request, phase);
    const registration = captured.registration;
    if (registration.target.proof.ownerEpoch !== proof.ownerEpoch)
      fail("BACKEND_OWNER_STALE");
    this.assertBinding(registration.target.binding);
    if (phase === "dispatch") {
      this.enabled();
      this.assertTarget(registration.target, registration.record.spec);
      const current = this.native().getBackend(
        proof.workspaceId,
        registration.record.backendId,
      );
      if (
        !current?.enabled ||
        current.id !== registration.record.id ||
        current.spec.sha256 !== registration.record.spec.sha256 ||
        proof.configSha256 !== current.spec.target.runConfigSha256 ||
        proof.catalogueSha256 !== current.spec.target.catalogueSha256
      )
        fail("BACKEND_OWNER_STALE");
    }
  }
  captureLaunch(
    request: TurnRequest,
    spec: AgentBackendSpec,
    backendRevisionId: string,
  ): object {
    this.enabled();
    const owner = this.readOwner(request);
    this.assertOwnerCurrent(request, owner, "dispatch");
    const registration = this.registrations.get(spec.id)!;
    if (
      spec.sessionLoad &&
      this.native()
        .inspectConnections(owner.workspaceId)
        .some((c) => c.backendId === spec.id)
    )
      fail("BACKEND_LOAD_ALIAS_USED");
    if (
      registration.record.id !== backendRevisionId ||
      registration.record.spec.sha256 !== spec.sha256
    )
      fail("BACKEND_LAUNCH_STALE");
    if (this.consumedLaunches.has(request))
      fail("BACKEND_ATTEMPT_ALREADY_LAUNCHED");
    this.consumedLaunches.add(request);
    const env: Record<string, string> = {};
    if (spec.credentialReference !== null)
      fail("BACKEND_CREDENTIAL_AUTH_UNSUPPORTED");
    for (const item of spec.launch.envReferences) {
      if (!this.secrets) fail("BACKEND_CREDENTIAL_UNAVAILABLE");
      const value = this.secrets.resolve(agentBackendJson(item.reference), {
        workspaceId: owner.workspaceId,
        backendId: spec.id,
        audience: spec.endpointAudience,
      });
      if (
        typeof value !== "string" ||
        !value ||
        Buffer.byteLength(value) > 16384 ||
        value.includes("\0")
      )
        fail("BACKEND_CREDENTIAL_UNAVAILABLE");
      env[item.name] = value;
    }
    this.assertOwnerCurrent(request, owner, "dispatch");
    this.engine.store.commitRunObservation(
      owner.runId,
      "backend.launch_reserved",
      {
        backendId: spec.id,
        backendRevisionId,
        ownerSha256: owner.sha256,
        launchSha256: registration.target.proof.launchSha256,
        turnId: owner.turnId,
        attemptId: owner.attemptId,
        requestSha256: owner.requestSha256,
      },
      { turnId: owner.turnId, attemptId: owner.attemptId },
    );
    const proof = signed({
      workspaceId: owner.workspaceId,
      backendId: spec.id,
      backendSha256: spec.sha256,
      backendRevisionId,
      ownerSha256: owner.sha256,
      command: spec.launch.command,
      args: spec.launch.args,
      cwd: spec.launch.cwd,
      env,
      executionLockPath: this.executionLockPath,
      ...(this.clientEffectsEnabled()
        ? { executionMode: "engine-client-effects" as const }
        : {}),
      clientCapabilities: {
        readTextFile: request.tools.some((t) => t.name === "read_file"),
        writeTextFile:
          this.clientEffectsEnabled() &&
          request.tools.some((t) => t.name === "apply_patch"),
        terminal:
          this.terminalEffectsEnabled() &&
          process.platform !== "win32" &&
          request.tools.some((t) => t.name === "run_command"),
      },
      launchSha256: registration.target.proof.launchSha256,
    });
    const original = this.issue(this.launches, {
      request,
      target: registration.target,
      spec,
      revisionId: backendRevisionId,
      proof,
    });
    this.launchOwners.set(owner.sha256, {
      request: new WeakRef(request),
      proof,
    });
    return original;
  }
  /** The Engine calls this only after reading the original owned process handle. */
  observeConnection(
    original: object,
    proof: BackendConnectionProof,
  ): BackendConnectionProof {
    const captured = this.admittedConnections.get(original);
    if (captured) {
      if (captured !== knowledgeHash(proof)) fail("BACKEND_CONNECTION_STALE");
      return proof;
    }
    const launch = this.launchOwners.get(proof.ownerSha256),
      request = launch?.request.deref();
    if (!launch || !request) fail("BACKEND_ORIGINAL_REQUIRED");
    const owner = this.readOwner(request);
    this.assertOwnerCurrent(request, owner, "observe");
    if (
      proof.ownerSha256 !== owner.sha256 ||
      proof.workspaceId !== launch.proof.workspaceId ||
      proof.backendId !== launch.proof.backendId ||
      proof.backendRevisionId !== launch.proof.backendRevisionId ||
      proof.backendSha256 !== launch.proof.backendSha256 ||
      proof.launchSha256 !== launch.proof.launchSha256 ||
      proof.processId <= 0
    )
      fail("BACKEND_CONNECTION_STALE");
    this.engine.store.commitRunObservation(
      owner.runId,
      "backend.connection_admitted",
      {
        connectionId: proof.connectionId,
        epoch: proof.epoch,
        processId: proof.processId,
        birthNonce: proof.birthNonce,
        ownerSha256: proof.ownerSha256,
        backendRevisionId: proof.backendRevisionId,
        backendId: proof.backendId,
        backendSha256: proof.backendSha256,
        launchSha256: proof.launchSha256,
        ...(proof.executionMode ? { executionMode: proof.executionMode } : {}),
        ...(proof.clientCapabilities
          ? { clientCapabilities: proof.clientCapabilities }
          : {}),
      },
      { turnId: owner.turnId, attemptId: owner.attemptId },
    );
    this.admittedConnections.set(original, knowledgeHash(proof));
    this.launchOwners.delete(proof.ownerSha256);
    return proof;
  }
  readLaunch(original: object): BackendLaunchProof {
    return agentBackendJson(this.original(this.launches, original).proof);
  }
  assertLaunchCurrent(original: object): void {
    const launch = this.original(this.launches, original),
      owner = this.readOwner(launch.request);
    this.assertOwnerCurrent(launch.request, owner, "dispatch");
    const current = this.native().getBackend(owner.workspaceId, launch.spec.id);
    if (
      current?.id !== launch.revisionId ||
      current.spec.sha256 !== launch.spec.sha256
    )
      fail("BACKEND_LAUNCH_STALE");
  }
  assertLaunchObserving(original: object): void {
    const launch = this.original(this.launches, original),
      owner = this.readOwner(launch.request);
    this.assertOwnerCurrent(launch.request, owner, "observe");
  }
  releaseLaunch(original: object): void {
    const launch = this.launches.get(original);
    if (launch) this.launchOwners.delete(launch.proof.ownerSha256);
    this.launches.delete(original);
    this.retained.delete(original);
  }
  releaseTarget(original: object): void {
    this.targets.delete(original);
    this.retained.delete(original);
  }
  clientReadPort(): BackendNativeClientEffectPort {
    return {
      prepareEffect: (request, input, signal) => {
        const owner = this.readOwner(request);
        this.assertOwnerCurrent(request, owner, "dispatch");
        return this.engine.coordinator.prepareProviderClientEffect(
          request,
          input,
          signal,
        );
      },
      readTerminalOutput: (original) => {
        const { permission, input, noProcessCompletionSha256 } =
          this.engine.coordinator.readProviderClientEffectScope(original);
        const jobId = `command-${knowledgeHash({ runId: permission.runId, toolCallId: permission.toolCallId }).slice(0, 32)}`;
        if (
          noProcessCompletionSha256 &&
          (this.engine.store.getOwnedCommandJob(
            permission.workspaceId,
            jobId,
          ) ||
            this.engine.store
              .listCheckpoints(permission.runId)
              .some(
                (checkpoint) => checkpoint.toolCallId === permission.toolCallId,
              ))
        )
          fail("BACKEND_EFFECT_COMPLETION_INVALID");
        const captured = noProcessCompletionSha256
          ? null
          : this.engine.captureOwnedCommandJobOutput({
              workspaceId: permission.workspaceId,
              jobId,
            });
        let output = "",
          observedBytes = 0,
          retainedBytes = 0;
        try {
          let afterSeq = 0;
          for (let pages = 0; captured && pages < 16; pages++) {
            const page = this.engine.readOwnedCommandJobOutput(captured, {
              afterSeq,
              maxBytes: 65536,
            });
            output += page.output.map((item) => item.data).join("");
            observedBytes = page.observedBytes;
            retainedBytes = page.retainedBytes;
            if (!page.hasMore) break;
            if (page.nextAfterSeq <= afterSeq)
              fail("BACKEND_TERMINAL_OUTPUT_LIMIT");
            afterSeq = page.nextAfterSeq;
          }
        } finally {
          if (captured) this.engine.releaseOwnedCommandJobHandle(captured);
        }
        const bytes = Buffer.from(output),
          limit = input.outputByteLimit;
        let start = Math.max(0, bytes.length - limit);
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        const result = {
          output: bytes.subarray(start).toString("utf8"),
          truncated: start > 0 || observedBytes > retainedBytes,
        };
        this.engine.store.commitRunObservation(
          permission.runId,
          "backend.terminal_output_observed",
          {
            toolCallId: permission.toolCallId,
            providerToolCallId: permission.providerToolCallId,
            output: result,
            ...(noProcessCompletionSha256 ? { noProcessCompletionSha256 } : {}),
          },
          { turnId: permission.turnId, attemptId: permission.attemptId },
        );
        return result;
      },
      readPermission: (original) =>
        this.engine.coordinator.readProviderClientEffectPermission(original),
      dispatchEffect: (original) => {
        const request =
          this.engine.coordinator.readProviderClientEffectRequest(original);
        const owner = this.readOwner(request);
        this.assertOwnerCurrent(request, owner, "dispatch");
        return this.engine.coordinator.dispatchProviderClientEffect(original);
      },
      waitEffect: (original) =>
        this.engine.coordinator.waitProviderClientEffect(original),
      cancelEffect: (original) =>
        this.engine.coordinator.cancelProviderClientEffect(original),
      releaseEffect: (original) =>
        this.engine.coordinator.releaseProviderClientEffect(original),
      executeRead: async (request, input, signal) => {
        const owner = this.readOwner(request);
        this.assertOwnerCurrent(request, owner, "dispatch");
        return this.engine.coordinator.executeProviderClientRead(
          request,
          input,
          signal,
        );
      },
      readCompletion: (original) =>
        this.engine.coordinator.readProviderClientReadCompletion(original),
      releaseCompletion: (original) =>
        this.engine.coordinator.releaseProviderClientReadCompletion(original),
    };
  }
  close(): void {
    this.closed = true;
    for (const original of this.retained) {
      this.targets.delete(original);
      this.launches.delete(original);
    }
    this.retained.clear();
    this.registrations.clear();
    this.launchOwners.clear();
  }
}
