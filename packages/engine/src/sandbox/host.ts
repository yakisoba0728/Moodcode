import { assertResidentProviderDispatch } from "../child-tasks/resident.js";
import { narrowedResidentConfig } from "./resident-config.js";
import { types } from "node:util";
import { release as osRelease } from "node:os";
import { randomUUID } from "node:crypto";
import { relative, resolve, isAbsolute } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { MoodcodeEngine } from "../engine.js";
import type { ToolContext, PreparedTool } from "../ports.js";
import type { RunConfigInput, JsonObject } from "@moodcode/contracts";
import { normalizeSubmitInput } from "@moodcode/contracts/validation";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  describeQueueTarget,
  jobTargetChanged,
} from "../runner/queue-target.js";
import { McpClient } from "../mcp/client.js";
import { StdioMcpTransport } from "../mcp/stdio.js";
import type {
  CommandExecutionObserver,
  CommandExecutionCompletion,
} from "../tools/command/observation.js";
import { SandboxStorage } from "./records.js";
import {
  probeSeatbelt,
  physicalPin,
  assertPin,
  canonicalWorkspacePath,
  gitControlPaths,
  seatbeltProfile,
} from "./platform-backends.js";
import {
  sandboxJson,
  sandboxObject,
  sandboxSign,
  sandboxError,
  type SandboxGrant,
  type SandboxCapability,
  type SandboxLaunch,
  type PreviewSandboxGrantInput,
  type ApproveSandboxGrantInput,
  type SandboxRecord,
  SANDBOX_LIMITS,
} from "./types.js";
interface Flight {
  context: ToolContext;
  record: SandboxRecord;
}
/** Only this actual root service issues runtime grants. Journal snapshots never recreate them. */
export class SandboxHost implements CommandExecutionObserver {
  private readonly epoch = knowledgeHash({ nonce: randomUUID() });
  private backend?: SandboxCapability;
  private readonly previews = new WeakMap<object, SandboxGrant>();
  private readonly grants = new Map<string, SandboxGrant>();
  private readonly entries = new WeakMap<object, Flight>();
  private readonly handles = new Set<object>();
  private readonly mcpOwners = new WeakSet<object>();
  private readonly mcpBinders = new WeakMap<object, () => SandboxRecord>();
  private readonly childGuards = new Map<string, () => void>();
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly native: SandboxStorage,
    private readonly options: {
      enabled: boolean;
      binding: (ws: string) => KnowledgeHostBinding;
      excluded: readonly string[];
      active: () => boolean;
    },
  ) {
    native.recover();
  }
  private active() {
    if (!this.options.enabled) sandboxError("SANDBOX_DISABLED");
    if (this.engine.lifecycleHooks.list().length)
      sandboxError("SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED");
    if (!this.options.active()) sandboxError("ENGINE_CLOSED");
  }
  async registerSandboxBackend(): Promise<SandboxCapability> {
    this.active();
    if (this.backend) return sandboxJson(this.backend);
    const b = await probeSeatbelt();
    this.active();
    this.backend = b;
    if (!b.available) sandboxError(b.code ?? "SANDBOX_UNSUPPORTED");
    return sandboxJson(b);
  }
  capability(): SandboxCapability | undefined {
    return this.backend && sandboxJson(this.backend);
  }
  private current(
    g: SandboxGrant,
    config?: RunConfigInput,
    originalResident = false,
  ): void {
    this.active();
    if (
      !this.backend ||
      this.backend.sha256 !== g.backend.sha256 ||
      osRelease() !== g.backend.osRelease
    )
      sandboxError("SANDBOX_BACKEND_STALE");
    assertPhysicalKnowledgeRoot(this.options.binding(g.workspaceId));
    if (
      knowledgeHash(this.options.binding(g.workspaceId)) !== g.rootBindingSha256
    )
      sandboxError("SANDBOX_SOURCE_STALE");
    for (const p of g.pins) assertPin(p);
    assertPin(g.backend.executable!);
    this.childGuards.get(g.sessionId)?.();
    if (config) {
      const cfg = normalizeSubmitInput(
        {
          sessionId: g.sessionId,
          requestId: "sandbox-validation",
          prompt: "sandbox-validation",
          config,
        },
        this.engine.getCapabilities().defaults,
      ).config;
      let capturedConfig = cfg;
      if (knowledgeHash(cfg) !== g.target.runConfigSha256) {
        if (!originalResident || !narrowedResidentConfig(g.target.config, cfg))
          sandboxError("SANDBOX_TARGET_STALE");
        capturedConfig = g.target.config;
      }
      const target = describeQueueTarget(
        this.engine,
        this.options.binding,
        g.workspaceId,
        g.sessionId,
        capturedConfig,
        jobTargetChanged,
      ).pin;
      if (knowledgeHash(target) !== knowledgeHash(g.target))
        sandboxError("SANDBOX_TARGET_STALE");
    } else {
      const t = describeQueueTarget(
        this.engine,
        this.options.binding,
        g.workspaceId,
        g.sessionId,
        g.target.config,
        jobTargetChanged,
      ).pin;
      if (knowledgeHash(t) !== knowledgeHash(g.target))
        sandboxError("SANDBOX_TARGET_STALE");
    }
  }
  async preview(input: PreviewSandboxGrantInput): Promise<object> {
    this.active();
    const x = sandboxObject(input, [
      "workspaceId",
      "sessionId",
      "config",
      "readPaths",
      "writePaths",
      "network",
    ]);
    if (!this.backend?.available) sandboxError("SANDBOX_BACKEND_REQUIRED");
    if (
      x.network !== "deny" ||
      !Array.isArray(x.readPaths) ||
      !Array.isArray(x.writePaths) ||
      x.readPaths.length > SANDBOX_LIMITS.paths ||
      x.writePaths.length > SANDBOX_LIMITS.paths
    )
      sandboxError("SANDBOX_RESTRICTION_UNSUPPORTED");
    if (this.engine.store.getSessionControl(x.sessionId).paused)
      sandboxError("SANDBOX_SESSION_PAUSED");
    const binding = this.options.binding(x.workspaceId);
    assertPhysicalKnowledgeRoot(binding);
    const root = binding.root,
      read = [
        ...new Set(
          [...x.readPaths, ...x.writePaths].map((p) =>
            canonicalWorkspacePath(root, p),
          ),
        ),
      ].sort(),
      write = [
        ...new Set(x.writePaths.map((p) => canonicalWorkspacePath(root, p))),
      ].sort();
    if (!read.length) sandboxError("SANDBOX_PATH");
    const excluded = this.options.excluded.map((p) =>
      existsSync(p) ? realpathSync(p) : resolve(p),
    );
    for (const p of [...read, ...write])
      if (excluded.some((e) => p === e || p.startsWith(e + "/")))
        sandboxError("SANDBOX_PATH");
    const config = normalizeSubmitInput(
        {
          sessionId: x.sessionId,
          requestId: "sandbox-preview",
          prompt: "sandbox-preview",
          config: x.config,
        },
        this.engine.getCapabilities().defaults,
      ).config,
      target = describeQueueTarget(
        this.engine,
        this.options.binding,
        x.workspaceId,
        x.sessionId,
        config,
        jobTargetChanged,
      ).pin,
      pins = [
        physicalPin(root),
        ...read.filter((p) => p !== root).map(physicalPin),
        physicalPin(realpathSync(process.execPath)),
      ];
    const profile = seatbeltProfile(
        read,
        write,
        excluded,
        [realpathSync(process.execPath)],
        gitControlPaths(root, write),
      ),
      restriction = knowledgeHash({
        backend: this.backend.sha256,
        target,
        read,
        write,
        pins,
        excluded,
        profile,
      }),
      launch = sandboxSign({
        version: 1 as const,
        backend: "darwin-seatbelt-v1" as const,
        executable: this.backend.executable!.path,
        profile,
        grantSha256: restriction,
      });
    const g = sandboxSign({
      version: 1 as const,
      id: randomUUID(),
      workspaceId: x.workspaceId,
      sessionId: x.sessionId,
      root,
      ownerEpoch: this.epoch,
      rootBindingSha256: knowledgeHash(binding),
      backend: this.backend,
      target,
      readPaths: read,
      writePaths: write,
      pins,
      excluded,
      profile,
      launch,
    });
    this.current(g);
    if (this.handles.size >= 128) sandboxError("SANDBOX_LIMIT");
    const original = Object.freeze({});
    this.previews.set(original, g);
    this.handles.add(original);
    return original;
  }
  read(original: object): SandboxGrant {
    const g = this.previews.get(original);
    if (!g) sandboxError("SANDBOX_ORIGINAL_REQUIRED");
    return sandboxJson(g);
  }
  async approve(
    input: ApproveSandboxGrantInput,
  ): Promise<{ duplicate: boolean; record: SandboxRecord }> {
    this.active();
    if (
      !input ||
      types.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      sandboxError("SANDBOX_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some(
        (k) =>
          typeof k !== "string" ||
          !Object.hasOwn(descriptors[k]!, "value") ||
          !descriptors[k]!.enumerable,
      ) ||
      !descriptors.preview
    )
      sandboxError("SANDBOX_INVALID");
    const original = descriptors.preview!.value as object;
    const rest = Object.fromEntries(
      Object.entries(descriptors)
        .filter(([k]) => k !== "preview")
        .map(([k, d]) => [k, d.value]),
    );
    const x = sandboxObject(rest, [
      "workspaceId",
      "requestId",
      "expectedRevision",
      "fingerprint",
      "approved",
    ]);
    if (
      typeof x.requestId !== "string" ||
      x.requestId.length > 128 ||
      !Number.isSafeInteger(x.expectedRevision)
    )
      sandboxError("SANDBOX_INVALID");
    const digest = knowledgeHash(x),
      existing = this.native
        .list(x.workspaceId)
        .find((r) => r.kind === "grant" && r.requestId === x.requestId);
    if (existing) {
      if (existing.requestSha256 !== digest)
        sandboxError("SANDBOX_REQUEST_CONFLICT");
      return { duplicate: true, record: existing };
    }
    const g = this.previews.get(original);
    if (!g || !this.handles.has(original))
      sandboxError("SANDBOX_ORIGINAL_REQUIRED");
    if (x.approved !== true) sandboxError("SANDBOX_APPROVAL_DENIED");
    if (
      x.workspaceId !== g.workspaceId ||
      x.fingerprint !== g.sha256 ||
      x.expectedRevision !== 0
    )
      sandboxError("SANDBOX_APPROVAL_STALE");
    return this.engine.coordinator.withWorkspaceLease(
      g.workspaceId,
      async () => {
        this.current(g);
        const now = new Date().toISOString(),
          r = sandboxSign({
            version: 1 as const,
            id: g.id,
            kind: "grant" as const,
            workspaceId: g.workspaceId,
            sessionId: g.sessionId,
            revision: 1,
            previousSha256: null,
            state: "approved" as const,
            grant: g,
            owner: null,
            groupPid: null,
            completion: null,
            requestId: x.requestId,
            requestSha256: digest,
            createdAt: now,
            updatedAt: now,
          });
        const saved = this.native.write(r, 0);
        this.grants.set(g.sessionId, g);
        this.handles.delete(original);
        return { duplicate: false, record: saved };
      },
    );
  }
  release(original: object) {
    this.handles.delete(original);
    this.previews.delete(original);
  }
  launch(context: ToolContext): SandboxLaunch {
    if (!this.options.enabled) sandboxError("SANDBOX_DISABLED");
    this.engine.coordinator.captureToolCatalogue(context);
    const run = this.engine.store.getRun(context.runId),
      g = this.grants.get(context.sessionId);
    if (!g) sandboxError("SANDBOX_GRANT_REQUIRED");
    // The private resident guard authenticates this exact current native Run,
    // its saved configuration and remaining lifetime allocation before narrowing.
    const originalResident =
      this.childGuards.has(context.sessionId) &&
      assertResidentProviderDispatch(this.engine, run);
    this.current(g, run.config, originalResident);
    return sandboxJson(g.launch);
  }
  hostLaunch(workspaceId: string, sessionId: string): SandboxLaunch {
    const g = this.grants.get(sessionId);
    if (!g || g.workspaceId !== workspaceId)
      sandboxError("SANDBOX_GRANT_REQUIRED");
    this.current(g);
    return sandboxJson(g.launch);
  }
  beforeSpawn(context: ToolContext, prepared: PreparedTool): object {
    const owner = this.engine.coordinator.readOwnedCommandContext(
        context,
        "start",
      ),
      launch = this.launch(context),
      g = this.grants.get(context.sessionId)!;
    if (knowledgeHash(prepared.preview.sandbox) !== knowledgeHash(launch))
      sandboxError("SANDBOX_APPROVAL_STALE");
    const now = new Date().toISOString(),
      r = sandboxSign({
        version: 1 as const,
        id:
          "sandbox-command-" +
          knowledgeHash([context.runId, context.toolCallId]).slice(0, 32),
        kind: "command" as const,
        workspaceId: g.workspaceId,
        sessionId: g.sessionId,
        revision: 1,
        previousSha256: null,
        state: "starting" as const,
        grant: g,
        owner: sandboxJson({
          ...owner,
          preparedSha256: knowledgeHash(prepared),
          command: (prepared.input as JsonObject).command,
        }) as JsonObject,
        groupPid: null,
        completion: null,
        requestId: context.toolCallId,
        requestSha256: knowledgeHash(prepared),
        createdAt: now,
        updatedAt: now,
      });
    const original = Object.freeze({}),
      entry = { context, record: this.native.write(r, 0) };
    this.entries.set(original, entry);
    return original;
  }
  private update(
    entry: Flight,
    state: SandboxRecord["state"],
    extra: Partial<SandboxRecord> = {},
  ) {
    const { sha256: _sha, ...body } = entry.record;
    entry.record = this.native.write(
      sandboxSign({
        ...body,
        ...extra,
        state,
        revision: body.revision + 1,
        previousSha256: entry.record.sha256,
        updatedAt: new Date().toISOString(),
      }),
      body.revision,
    );
  }
  started(original: object, pid: number) {
    const e = this.entries.get(original);
    if (!e) sandboxError("SANDBOX_ORIGINAL_REQUIRED");
    this.engine.coordinator.readOwnedCommandContext(e.context, "start");
    this.update(e, "running", { groupPid: pid });
  }
  output(
    _original: object,
    _stream: "stdout" | "stderr",
    _bytes: Buffer,
  ): void {}
  closed(original: object, c: CommandExecutionCompletion) {
    const e = this.entries.get(original);
    if (!e) sandboxError("SANDBOX_ORIGINAL_REQUIRED");
    this.engine.coordinator.readOwnedCommandContext(e.context, "settle");
    this.update(
      e,
      c.outcome.cleanupConfirmed && !c.observationFailure
        ? "closed"
        : "uncertain",
      {
        completion: sandboxJson({
          outcome: c.outcome,
          stdout: c.stdout,
          stderr: c.stderr,
          checkpointId: c.checkpoint.id,
          checkpointSha256: knowledgeHash(c.checkpoint),
          partialEffects: c.checkpoint.files.map((f) => f.path),
          denialObserved: false,
          denialClassification: "unknown-unless-explicit-kernel-error",
          observationFailure: c.observationFailure ?? null,
        }) as unknown as JsonObject,
      },
    );
  }
  failed(original: object, _error: unknown) {
    const e = this.entries.get(original);
    if (e && !["closed", "uncertain"].includes(e.record.state))
      try {
        this.update(e, "uncertain");
      } catch {
        /* Original caller marks native cleanup uncertain; recovery never replays. */
      }
  }
  inspect(workspaceId: string) {
    return this.native.list(workspaceId);
  }
  inherit(child: SandboxHost, sessionId: string, parentRunId: string): void {
    if (!this.options.enabled) return;
    const run = this.engine.store.getRun(parentRunId),
      g = this.grants.get(run.sessionId);
    if (!g) sandboxError("SANDBOX_GRANT_REQUIRED");
    this.current(g, run.config);
    const workspace = child.engine.store.getWorkspace(
        child.engine.store.getSession(sessionId).workspaceId,
      ),
      map = (paths: readonly string[]) =>
        paths.map((p) => {
          const r = relative(g.root, p);
          if (r === ".." || r.startsWith("../") || isAbsolute(r))
            sandboxError("SANDBOX_CHILD_SCOPE");
          const dest = resolve(workspace.root, r);
          return canonicalWorkspacePath(workspace.root, dest);
        });
    child.backend = g.backend;
    const cfg = child.engine.getCapabilities().defaults as RunConfigInput,
      target = describeQueueTarget(
        child.engine,
        child.options.binding,
        workspace.id,
        sessionId,
        child.engine.profiles.apply(
          sessionId,
          normalizeSubmitInput({
            sessionId,
            requestId: "sandbox-child",
            prompt: "sandbox-child",
            config: cfg,
          }).config,
        ),
        jobTargetChanged,
      ).pin,
      read = map(g.readPaths),
      write = map(g.writePaths),
      excluded = child.options.excluded,
      profile = seatbeltProfile(
        read,
        write,
        excluded,
        [realpathSync(process.execPath)],
        gitControlPaths(workspace.root, write),
      ),
      pins = [
        physicalPin(workspace.root),
        ...read.filter((p) => p !== workspace.root).map(physicalPin),
        physicalPin(realpathSync(process.execPath)),
      ],
      launch = sandboxSign({
        version: 1 as const,
        backend: "darwin-seatbelt-v1" as const,
        executable: g.launch.executable,
        profile,
        grantSha256: knowledgeHash({
          parent: g.sha256,
          target,
          read,
          write,
          pins,
          profile,
        }),
      });
    const inherited = sandboxSign({
      ...g,
      id: randomUUID(),
      sessionId,
      workspaceId: workspace.id,
      root: workspace.root,
      rootBindingSha256: knowledgeHash(child.options.binding(workspace.id)),
      ownerEpoch: child.epoch,
      target,
      readPaths: read,
      writePaths: write,
      excluded,
      pins,
      profile,
      launch,
    });
    child.childGuards.set(sessionId, () => {
      if (this.grants.get(run.sessionId) !== g)
        sandboxError("SANDBOX_PARENT_STALE");
      this.current(g, run.config);
    });
    child.grants.set(sessionId, inherited);
  }
  async connectMcp(input: {
    workspaceId: string;
    sessionId: string;
    id: string;
    command: string;
    args: readonly string[];
    sourceFiles: readonly string[];
  }): Promise<{
    client: McpClient;
    connected: Awaited<ReturnType<MoodcodeEngine["connectMcp"]>>;
  }> {
    this.active();
    const x = sandboxObject(input, [
        "workspaceId",
        "sessionId",
        "id",
        "command",
        "args",
        "sourceFiles",
      ]),
      g = this.grants.get(x.sessionId);
    if (!g || g.workspaceId !== x.workspaceId)
      sandboxError("SANDBOX_GRANT_REQUIRED");
    this.current(g);
    if (
      !Array.isArray(x.args) ||
      x.args.length > 64 ||
      x.args.some((a) => typeof a !== "string" || a.length > 8192) ||
      !Array.isArray(x.sourceFiles) ||
      x.sourceFiles.length > 32
    )
      sandboxError("SANDBOX_INVALID");
    const command = realpathSync(x.command);
    if (
      !["/bin/", "/usr/bin/"].some((prefix) => command.startsWith(prefix)) &&
      command !== realpathSync(process.execPath)
    )
      sandboxError("SANDBOX_MCP_EXECUTABLE_UNSUPPORTED");
    const pins = [
      physicalPin(command),
      ...x.sourceFiles.map((path) =>
        physicalPin(canonicalWorkspacePath(g.root, path)),
      ),
    ];
    for (const pin of pins.slice(1))
      if (
        !g.readPaths.some((p) => pin.path === p || pin.path.startsWith(p + "/"))
      )
        sandboxError("SANDBOX_PATH");
    const profile = seatbeltProfile(
        g.readPaths,
        [],
        g.excluded,
        [realpathSync(process.execPath)],
        null,
      ),
      launch = sandboxSign({
        ...g.launch,
        profile,
        grantSha256: knowledgeHash({
          parent: g.sha256,
          profile,
          kind: "mcp-readonly",
        }),
      }),
      now = new Date().toISOString();
    let record: SandboxRecord | undefined;
    let registered = false,
      binding: SandboxGrant | undefined,
      expectedTarget: SandboxGrant["target"] | undefined;
    const guard = (message?: import("../mcp/protocol.js").JsonRpcMessage) => {
      const current = this.grants.get(x.sessionId);
      if (!current) sandboxError("SANDBOX_GRANT_REQUIRED");
      if (registered && !binding) sandboxError("SANDBOX_MCP_UNBOUND");
      if (current !== (binding ?? g)) sandboxError("SANDBOX_MCP_GRANT_STALE");
      if (
        !binding &&
        message &&
        (!("method" in message) ||
          ![
            "server/discover",
            "initialize",
            "notifications/initialized",
            "tools/list",
            "resources/list",
            "ping",
            "notifications/cancelled",
          ].includes(message.method))
      )
        sandboxError("SANDBOX_MCP_UNBOUND");
      this.current(current);
      for (const pin of pins) assertPin(pin);
      if (
        seatbeltProfile(
          current.readPaths,
          [],
          current.excluded,
          [realpathSync(process.execPath)],
          null,
        ) !== profile
      )
        sandboxError("SANDBOX_MCP_GRANT_STALE");
      return launch;
    };
    const transport = new StdioMcpTransport({
      command,
      args: x.args,
      cwd: g.root,
      sandbox: guard,
      observer: {
        beforeStart: () => {
          guard();
          record = this.native.write(
            sandboxSign({
              version: 1 as const,
              id: "sandbox-mcp-" + randomUUID(),
              kind: "mcp" as const,
              workspaceId: g.workspaceId,
              sessionId: g.sessionId,
              revision: 1,
              previousSha256: null,
              state: "starting" as const,
              grant: g,
              owner: sandboxJson({
                clientId: x.id,
                command,
                args: x.args,
                pins,
                profileSha256: knowledgeHash(profile),
                launchSha256: launch.sha256,
                authority: "read-only-stdio",
              }) as unknown as JsonObject,
              groupPid: null,
              completion: null,
              requestId: randomUUID(),
              requestSha256: knowledgeHash(x),
              createdAt: now,
              updatedAt: now,
            }),
            0,
          );
        },
        started: (pid) => {
          if (!record) sandboxError("SANDBOX_MCP_OWNER_INVALID");
          const { sha256: _sha, ...body } = record;
          record = this.native.write(
            sandboxSign({
              ...body,
              revision: body.revision + 1,
              previousSha256: record.sha256,
              state: "running" as const,
              groupPid: pid,
              updatedAt: new Date().toISOString(),
            }),
            body.revision,
          );
        },
        closed: (outcome) => {
          if (!record) return;
          const { sha256: _sha, ...body } = record;
          record = this.native.write(
            sandboxSign({
              ...body,
              revision: body.revision + 1,
              previousSha256: record.sha256,
              state: outcome.cleanupConfirmed
                ? ("closed" as const)
                : ("uncertain" as const),
              completion: sandboxJson({ outcome }) as unknown as JsonObject,
              updatedAt: new Date().toISOString(),
            }),
            body.revision,
          );
        },
      },
    });
    const client = new McpClient({ id: x.id, transport });
    this.mcpOwners.add(client);
    try {
      const connected = await this.engine.connectMcp(client);
      registered = true;
      expectedTarget = describeQueueTarget(
        this.engine,
        this.options.binding,
        g.workspaceId,
        g.sessionId,
        g.target.config,
        jobTargetChanged,
      ).pin;
      this.mcpBinders.set(client, () => {
        this.active();
        if (binding) sandboxError("SANDBOX_MCP_ALREADY_BOUND");
        const current = this.grants.get(g.sessionId);
        if (
          !current ||
          !expectedTarget ||
          !record ||
          record.state !== "running" ||
          !client.connected ||
          !record.groupPid
        )
          sandboxError("SANDBOX_MCP_UNBOUND");
        this.current(current);
        for (const pin of pins) assertPin(pin);
        if (
          knowledgeHash(current.target) !== knowledgeHash(expectedTarget) ||
          knowledgeHash(current.readPaths) !== knowledgeHash(g.readPaths) ||
          knowledgeHash(current.writePaths) !== knowledgeHash(g.writePaths) ||
          knowledgeHash(current.pins) !== knowledgeHash(g.pins) ||
          knowledgeHash(current.excluded) !== knowledgeHash(g.excluded) ||
          current.rootBindingSha256 !== g.rootBindingSha256 ||
          current.ownerEpoch !== g.ownerEpoch ||
          current.profile !== g.profile ||
          current.backend.sha256 !== g.backend.sha256
        )
          sandboxError("SANDBOX_MCP_GRANT_STALE");
        const createdAt = new Date().toISOString(),
          receipt = this.native.write(
            sandboxSign({
              version: 1 as const,
              id:
                "sandbox-mcp-binding-" +
                knowledgeHash([record.id, current.sha256]).slice(0, 32),
              kind: "mcp-binding" as const,
              workspaceId: current.workspaceId,
              sessionId: current.sessionId,
              revision: 1,
              previousSha256: null,
              state: "approved" as const,
              grant: current,
              owner: sandboxJson({
                connectionId: record.id,
                connectionSha256: record.sha256,
                clientId: x.id,
                launchSha256: launch.sha256,
                profileSha256: knowledgeHash(profile),
                bootstrapTargetSha256: knowledgeHash(expectedTarget),
              }) as unknown as JsonObject,
              groupPid: record.groupPid,
              completion: null,
              requestId: "bind:" + record.id,
              requestSha256: knowledgeHash([record.sha256, current.sha256]),
              createdAt,
              updatedAt: createdAt,
            }),
            0,
          );
        binding = current;
        return receipt;
      });
      return { client, connected };
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  bindMcp(original: object): SandboxRecord {
    const bind = this.mcpBinders.get(original);
    if (!bind) sandboxError("SANDBOX_ORIGINAL_REQUIRED");
    return bind();
  }
  hasMcp(original: object) {
    return this.mcpOwners.has(original);
  }
}
