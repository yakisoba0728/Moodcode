import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../storage/index.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  latestRequiredReceipts,
  verificationDocumentKind,
  type VerificationPlanService,
} from "../verification/plans.js";
import type { VerificationReceipt } from "../verification/types.js";
import type { VerificationHostService } from "../verification/host.js";
import { assertExecutionLockAvailable as verifyExecutionIdle } from "../tools/command/execution-lock.js";
import {
  repositoryPin,
  entriesFor,
  expectedTree,
  indexProjection,
  indexBeforeUpdate,
  fileBytes,
  objectOid,
  inspectCommit,
} from "./commit-preview.js";
import { GitCommitStorage } from "./commit-receipts.js";
import { groupExists } from "../tools/command/process-control.js";
import { openGitCommitProcess } from "./commit-process.js";
import {
  commitJson,
  commitId,
  commitDigest,
  gitCommitError,
  gitSha,
  signedCommit,
  GIT_COMMIT_LIMITS,
  type PreviewGitCommitInput,
  type CommitReviewedChangesInput,
  type GitCommitPreview,
  type GitCommitReceipt,
  type GitCommitResult,
  type GitCommitOutcome,
} from "./types.js";
interface HostPorts {
  store: SqliteStore;
  records: GitCommitStorage;
  plans: VerificationPlanService;
  verification: VerificationHostService;
  binding(workspaceId: string): KnowledgeHostBinding;
  enabled(): boolean;
  lease<T>(ws: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  recoveryLease<T>(
    ws: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  executionLockPath: string;
  artifactDir: string;
  lifetime: AbortSignal;
}
export class GitCommitHost {
  private readonly previews = new WeakMap<object, GitCommitPreview>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly epoch = gitSha(randomUUID());
  private closed = false;
  constructor(private readonly ports: HostPorts) {}
  private enabled() {
    if (this.closed || this.ports.lifetime.aborted)
      gitCommitError("ENGINE_CLOSED");
    if (!this.ports.enabled()) gitCommitError("GIT_COMMITS_UNSUPPORTED");
  }
  private tracked<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  preview(input: PreviewGitCommitInput): Promise<object> {
    this.enabled();
    const i = commitJson(input);
    for (const id of [i.sessionId, i.requestId, i.runId]) commitId(id);
    if (
      !["staged", "working-tree"].includes(i.selection) ||
      typeof i.message !== "string" ||
      !i.message.trim() ||
      Buffer.byteLength(i.message) > 8191
    )
      gitCommitError("INVALID_GIT_COMMIT");
    const keys = Object.keys(i);
    if (
      keys.some(
        (k) =>
          ![
            "sessionId",
            "requestId",
            "runId",
            "paths",
            "message",
            "selection",
            "timeoutMs",
            "maxOutputBytes",
          ].includes(k),
      )
    )
      gitCommitError("INVALID_GIT_COMMIT");
    const session = this.ports.store.getSession(i.sessionId);
    return this.tracked(
      this.ports.lease(session.workspaceId, async (signal) => {
        verifyExecutionIdle(this.ports.executionLockPath);
        const control = this.ports.store.getSessionControl(session.id);
        if (control.paused && control.reason === "recovery_required")
          gitCommitError("GIT_COMMIT_IMPORT_PAUSED");
        const run = this.ports.store.getRun(i.runId);
        if (
          run.sessionId !== session.id ||
          run.workspaceId !== session.workspaceId ||
          !["completed", "failed", "cancelled", "interrupted"].includes(
            run.state,
          )
        )
          gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
        if (
          this.ports.records.get(session.workspaceId, session.id, i.requestId)
        )
          gitCommitError("GIT_COMMIT_REQUEST_EXISTS");
        const binding = this.ports.binding(session.workspaceId),
          repository = await repositoryPin(binding.root, signal),
          configuration = this.ports.verification.configuration(session.id),
          snapshot = this.ports.plans.get(session.id, run.id),
          plan = snapshot?.plans.at(-1);
        if (
          !configuration ||
          !snapshot ||
          !plan ||
          i.paths.some(
            (path) =>
              !configuration.sourcePaths.some(
                (source) => path === source || path.startsWith(source + "/"),
              ),
          )
        )
          gitCommitError("GIT_COMMIT_VERIFICATION_SCOPE");
        const source = await this.ports.verification.observe(
          {
            sessionId: session.id,
            runId: run.id,
            workspace: this.ports.store.getWorkspace(session.workspaceId),
          },
          signal,
        );
        const receipts = latestRequiredReceipts(
          snapshot,
          plan,
          (r) => r.planId === plan.id,
        );
        if (
          !receipts.length ||
          !receipts.every(
            (r): r is VerificationReceipt =>
              r?.status === "pass" && r.sourceBefore.sha256 === source.sha256,
          )
        )
          gitCommitError("GIT_COMMIT_VERIFICATION_REQUIRED");
        const entries = await entriesFor(
          binding.root,
          i,
          repository.objectFormat,
          signal,
        );
        for (const e of entries)
          if (e.oid) {
            const bytes = await fileBytes(binding.root, e.path);
            if (
              !bytes ||
              objectOid("blob", bytes, repository.objectFormat) !== e.oid
            )
              gitCommitError("GIT_COMMIT_VERIFIED_INDEX_MISMATCH");
          }
        const timeoutMs =
            i.timeoutMs ?? Math.min(10000, run.config.limits.toolTimeoutMs),
          maxOutputBytes =
            i.maxOutputBytes ??
            Math.min(32768, run.config.limits.maxOutputBytes);
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs >
            Math.min(
              GIT_COMMIT_LIMITS.timeoutMs,
              run.config.limits.toolTimeoutMs,
              run.config.limits.maxDurationMs,
            ) ||
          !Number.isSafeInteger(maxOutputBytes) ||
          maxOutputBytes < 1024 ||
          maxOutputBytes >
            Math.min(
              GIT_COMMIT_LIMITS.outputBytes,
              run.config.limits.maxOutputBytes,
            )
        )
          gitCommitError("GIT_COMMIT_BUDGET");
        const doc = this.ports.store.getSessionDocument(
            session.id,
            verificationDocumentKind(run.id),
          )!,
          createdAt = new Date().toISOString(),
          preview = signedCommit({
            version: 1 as const,
            id: "gitcommit_" + randomUUID().replaceAll("-", ""),
            requestId: i.requestId,
            workspaceId: session.workspaceId,
            sessionId: session.id,
            runId: run.id,
            binding,
            ownerEpoch: this.epoch,
            repository,
            paths: [...i.paths].sort(),
            selection: i.selection,
            entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
            message: i.message.endsWith("\n") ? i.message : i.message + "\n",
            expectedTree: await expectedTree(
              binding.root,
              entries,
              repository.objectFormat,
              signal,
            ),
            expectedIndexProjectionSha256: await indexProjection(
              binding.root,
              i.selection === "working-tree" ? entries : [],
              signal,
            ),
            verification: receipts,
            verificationRevision: snapshot.revision,
            verificationDocumentSha256: gitSha(JSON.stringify(doc.data)),
            source,
            timeoutMs,
            maxOutputBytes,
            createdAt,
          });
        if (
          knowledgeHash(await repositoryPin(binding.root, signal)) !==
            knowledgeHash(repository) ||
          knowledgeHash(this.ports.binding(session.workspaceId)) !==
            knowledgeHash(binding)
        )
          gitCommitError("GIT_COMMIT_STALE");
        this.ports.records.write(
          signedCommit({
            version: 1 as const,
            id: preview.id,
            revision: 1,
            preview,
            state: "prepared" as const,
            requestSha256: null,
            outcome: null,
            commitSha: null,
            reconciled: false,
            errorCode: null,
            importArchiveSha256: null,
            createdAt,
            updatedAt: createdAt,
          }),
          0,
        );
        const original = Object.freeze({
          id: preview.id,
          sha256: preview.sha256,
        });
        this.previews.set(original, preview);
        return original;
      }),
    );
  }
  read(original: object): GitCommitPreview {
    const p = this.previews.get(original);
    if (!p) gitCommitError("GIT_COMMIT_PREVIEW_OWNER_INVALID");
    return structuredClone(p);
  }
  release(original: object): void {
    this.previews.delete(original);
  }
  commit(
    original: object,
    input: CommitReviewedChangesInput,
    signal?: AbortSignal,
  ): Promise<GitCommitResult> {
    this.enabled();
    const i = commitJson(input);
    for (const id of [i.workspaceId, i.sessionId, i.requestId]) commitId(id);
    commitDigest(i.previewSha256);
    if (
      i.expectedRevision !== 1 ||
      !["allow", "deny"].includes(i.decision) ||
      Object.keys(i).sort().join(",") !==
        "decision,expectedRevision,previewSha256,requestId,sessionId,workspaceId"
    )
      gitCommitError("INVALID_GIT_COMMIT");
    const requestSha256 = knowledgeHash(i),
      prior = this.ports.records.get(i.workspaceId, i.sessionId, i.requestId);
    if (prior?.requestSha256 !== null && prior?.requestSha256 !== undefined) {
      if (
        prior.requestSha256 !== requestSha256 ||
        prior.preview.sha256 !== i.previewSha256
      )
        gitCommitError("REQUEST_ID_CONFLICT");
      return Promise.resolve({
        kind: "duplicate",
        receipt: structuredClone(prior),
      });
    }
    const p = this.previews.get(original);
    if (
      !p ||
      p.sha256 !== i.previewSha256 ||
      p.workspaceId !== i.workspaceId ||
      p.sessionId !== i.sessionId ||
      p.requestId !== i.requestId ||
      prior?.state !== "prepared" ||
      prior.revision !== 1
    )
      gitCommitError("GIT_COMMIT_PREVIEW_OWNER_INVALID");
    return this.tracked(
      this.ports.lease(i.workspaceId, async (leaseSignal) => {
        const abort = signal
          ? AbortSignal.any([signal, leaseSignal, this.ports.lifetime])
          : AbortSignal.any([leaseSignal, this.ports.lifetime]);
        let current = this.ports.records.get(
          i.workspaceId,
          i.sessionId,
          i.requestId,
        )!;
        const write = (
          state: GitCommitReceipt["state"],
          extra: Partial<GitCommitReceipt> = {},
        ) =>
          (current = this.ports.records.write(
            signedCommit({
              ...current,
              ...extra,
              state,
              revision: current.revision + 1,
              updatedAt: new Date().toISOString(),
            }),
            current.revision,
          ));
        if (i.decision === "deny") {
          write("denied", { requestSha256 });
          this.release(original);
          return { kind: "settled" as const, receipt: current };
        }
        await this.assertCurrent(p, abort);
        write("approved", { requestSha256 });
        this.release(original);
        if (abort.aborted) {
          write("cancelled", { errorCode: "CANCELLED" });
          return { kind: "settled" as const, receipt: current };
        }
        let process:
          Awaited<ReturnType<typeof openGitCommitProcess>> | undefined;
        try {
          await this.assertCurrent(p, abort);
          process = await openGitCommitProcess(
            p,
            this.ports.executionLockPath,
            this.ports.artifactDir,
            abort,
            (pid) =>
              this.ports.store.commitGitCommitObservation(
                p.sessionId,
                "git.commit.process_admitted",
                { id: p.id, previewSha256: p.sha256, groupPid: pid },
              ),
          );
          this.ports.store.commitGitCommitObservation(
            p.sessionId,
            "git.commit.supervisor_admitted",
            {
              id: p.id,
              previewSha256: p.sha256,
              supervisorPid: process.supervisorPid,
            },
          );
          write("dispatched");
          const outcome = commitJson(await process.start());
          this.ports.store.commitGitCommitObservation(
            p.sessionId,
            "git.commit.closed",
            {
              id: p.id,
              previewSha256: p.sha256,
              outcome:
                outcome as unknown as import("@moodcode/contracts").JsonObject,
            },
          );
          const matches = this.matches(p, outcome);
          const confirmed =
            matches &&
            outcome.cleanupConfirmed &&
            outcome.started &&
            outcome.exitCode === 0 &&
            outcome.signal === null &&
            !outcome.cancelled &&
            !outcome.timedOut &&
            outcome.errorCode !== "GIT_COMMIT_PROCESS_RECORD_FAILED";
          write(
            confirmed
              ? "committed"
              : outcome.afterHead !== p.repository.head ||
                  !outcome.cleanupConfirmed
                ? "uncertain"
                : outcome.cancelled
                  ? "cancelled"
                  : "failed",
            {
              outcome,
              commitSha: matches ? outcome.afterHead : null,
              errorCode: confirmed
                ? null
                : (outcome.errorCode ?? "GIT_COMMIT_UNCERTAIN"),
            },
          );
        } catch (e) {
          await process?.stopAndJoin();
          let physicalIdle = false;
          try {
            verifyExecutionIdle(this.ports.executionLockPath);
            physicalIdle = true;
          } catch {}
          try {
            write(
              current.state === "approved" && physicalIdle
                ? "failed"
                : "uncertain",
              {
                errorCode:
                  current.state === "approved"
                    ? "GIT_COMMIT_NOT_DISPATCHED"
                    : "GIT_COMMIT_RECEIPT_PENDING",
              },
            );
          } catch {
            /* durable dispatch intent remains the quarantine, never a retry grant */
          }
        }
        return { kind: "settled" as const, receipt: structuredClone(current) };
      }),
    );
  }
  private matches(p: GitCommitPreview, o: GitCommitOutcome): boolean {
    return (
      this.landed(p, o) &&
      (p.selection === "staged"
        ? o.indexAfterSha256 === p.repository.indexSha256
        : o.indexAfterProjectionSha256 === p.expectedIndexProjectionSha256)
    );
  }
  /** The approved commit is HEAD and the selected sources are unchanged. */
  private landed(p: GitCommitPreview, o: GitCommitOutcome): boolean {
    return (
      o.afterHead !== p.repository.head &&
      o.afterHead !== null &&
      o.parent === p.repository.head &&
      o.tree === p.expectedTree &&
      o.message === p.message &&
      knowledgeHash(o.selectedAfter) ===
        knowledgeHash(
          p.entries.map((e) => ({ path: e.path, fileSha256: e.fileSha256 })),
        )
    );
  }
  private async assertCurrent(
    p: GitCommitPreview,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) gitCommitError("CANCELLED");
    verifyExecutionIdle(this.ports.executionLockPath);
    if (
      knowledgeHash(this.ports.binding(p.workspaceId)) !==
        knowledgeHash(p.binding) ||
      knowledgeHash(await repositoryPin(p.binding.root, signal)) !==
        knowledgeHash(p.repository)
    )
      gitCommitError("GIT_COMMIT_STALE");
    for (const e of p.entries) {
      const b = await fileBytes(p.binding.root, e.path);
      if ((b === null ? null : gitSha(b)) !== e.fileSha256)
        gitCommitError("GIT_COMMIT_STALE");
    }
    const snapshot = this.ports.plans.get(p.sessionId, p.runId),
      doc = this.ports.store.getSessionDocument(
        p.sessionId,
        verificationDocumentKind(p.runId),
      );
    if (
      snapshot?.revision !== p.verificationRevision ||
      !doc ||
      gitSha(JSON.stringify(doc.data)) !== p.verificationDocumentSha256 ||
      (
        await this.ports.verification.observe(
          {
            sessionId: p.sessionId,
            runId: p.runId,
            workspace: this.ports.store.getWorkspace(p.workspaceId),
          },
          signal,
        )
      ).sha256 !== p.source.sha256
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_STALE");
  }
  reconcile(input: {
    workspaceId: string;
    sessionId: string;
    requestId: string;
    expectedRevision: number;
  }): Promise<GitCommitReceipt> {
    this.enabled();
    const i = commitJson(input);
    return this.tracked(
      this.ports.recoveryLease(i.workspaceId, async (signal) => {
        const r = this.ports.records.get(
          i.workspaceId,
          i.sessionId,
          i.requestId,
        );
        if (!r || r.revision !== i.expectedRevision || r.state !== "uncertain")
          gitCommitError("REVISION_CONFLICT");
        if (
          knowledgeHash(this.ports.binding(i.workspaceId)) !==
          knowledgeHash(r.preview.binding)
        )
          gitCommitError("GIT_COMMIT_BINDING_STALE");
        verifyExecutionIdle(this.ports.executionLockPath);
        const p = r.preview,
          root = p.binding.root,
          actual = await inspectCommit(root, signal),
          repository = await repositoryPin(root, signal);
        if (
          repository.gitDirIdentity !== p.repository.gitDirIdentity ||
          repository.commonDirIdentity !== p.repository.commonDirIdentity ||
          repository.symbolicHead !== p.repository.symbolicHead
        )
          gitCommitError("GIT_COMMIT_RECONCILIATION_CONFLICT");
        const moved = actual.head !== p.repository.head,
          indexAfterProjectionSha256 = await indexProjection(root, [], signal);
        // The worker updates a working-tree index only after the commit: a moved
        // HEAD accepts it before or after that update, an unchanged HEAD only before.
        const indexKept =
          p.selection === "staged"
            ? repository.indexSha256 === p.repository.indexSha256
            : (moved &&
                indexAfterProjectionSha256 ===
                  p.expectedIndexProjectionSha256) ||
              (await indexBeforeUpdate(
                root,
                p.repository.head,
                p.entries,
                p.expectedIndexProjectionSha256,
                signal,
              ));
        if (!indexKept) gitCommitError("GIT_COMMIT_RECONCILIATION_CONFLICT");
        const evidence = this.ports.store.readGitCommitProcessEvidence(
          p.sessionId,
          r.id,
        );
        if (evidence.groupPid !== null && groupExists(evidence.groupPid))
          gitCommitError("CLEANUP_PENDING");
        if (evidence.supervisorPid !== null) {
          try {
            process.kill(evidence.supervisorPid, 0);
            gitCommitError("CLEANUP_PENDING");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        const outcome: GitCommitOutcome = {
          exitCode: null,
          signal: null,
          cancelled: false,
          timedOut: false,
          cleanupConfirmed: true,
          started: evidence.groupPid !== null,
          groupPid: evidence.groupPid,
          supervisorPid: evidence.supervisorPid,
          indexAfterSha256: repository.indexSha256,
          indexAfterProjectionSha256,
          selectedAfter: await Promise.all(
            p.entries.map(async (e) => {
              const bytes = await fileBytes(root, e.path);
              return {
                path: e.path,
                fileSha256: bytes === null ? null : gitSha(bytes),
              };
            }),
          ),
          stdout: "",
          stderr: "",
          beforeHead: p.repository.head,
          afterHead: actual.head,
          parent: actual.parent,
          tree: actual.tree,
          message: actual.message,
          errorCode: "GIT_COMMIT_RECONCILED",
        };
        const committed = this.landed(p, outcome);
        if (!committed && moved)
          gitCommitError("GIT_COMMIT_RECONCILIATION_CONFLICT");
        this.ports.store.commitGitCommitObservation(
          p.sessionId,
          "git.commit.reconciled",
          {
            id: r.id,
            previewSha256: p.sha256,
            outcome:
              outcome as unknown as import("@moodcode/contracts").JsonObject,
          },
        );
        return this.ports.records.write(
          signedCommit({
            ...r,
            revision: r.revision + 1,
            state: committed ? ("committed" as const) : ("failed" as const),
            outcome,
            commitSha: committed ? actual.head : null,
            reconciled: true,
            errorCode: null,
            updatedAt: new Date().toISOString(),
          }),
          r.revision,
        );
      }),
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
