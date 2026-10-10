import { knowledgeHash } from "../knowledge/validation.js";
import {
  PR_LIMITS,
  prChangesRequested,
  prFail,
  prGitSha,
  prInt,
  prJson,
  prSign,
  validatePrRepository,
  type PrPolicy,
  type PrRepository,
  type PrRemoteSnapshot,
  type PrCheckSnapshot,
  type PrReviewSnapshot,
} from "./types.js";
export class PrHttpError extends Error {
  constructor(
    readonly code: string,
    readonly retryAt: string | null = null,
  ) {
    super(code);
  }
}
function text(v: unknown, max = 512): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") prFail("PR_HTTP_SCHEMA");
  return Buffer.from(v)
    .subarray(0, max)
    .toString("utf8")
    .replace(/\u0000/g, "");
}
function stamp(v: unknown): string {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
    prFail("PR_HTTP_SCHEMA");
  return new Date(v).toISOString();
}
export function validatePrApiBase(
  value: string,
  allowLoopback = false,
): string {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    prFail("PR_ENDPOINT_UNSUPPORTED");
  if (
    u.origin !== "https://api.github.com" &&
    !(
      allowLoopback &&
      u.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    prFail("PR_ENDPOINT_UNSUPPORTED");
  return u.origin;
}
/** GET-only, unauthenticated adapter. Remote payloads remain quoted observations, never runtime authority. */
export class GitHubPrReader {
  private readonly cache = new Map<
    string,
    { etag: string | null; body: unknown }
  >();
  constructor(
    readonly apiBase: string,
    allowLoopback = false,
  ) {
    validatePrApiBase(apiBase + "/", allowLoopback);
  }
  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    if (this.cache.size > 128) this.cache.clear();
    const url = this.apiBase + path,
      cache = this.cache.get(url);
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Moodcode-readonly-pr-watch",
        ...(cache?.etag ? { "If-None-Match": cache.etag } : {}),
      },
    });
    try {
      if (response.status === 304) {
        if (!cache) prFail("PR_HTTP_CACHE_INVALID");
        return cache.body;
      }
      if (response.status === 429 || response.status === 403) {
        const retry = response.headers.get("retry-after"),
          reset = response.headers.get("x-ratelimit-reset");
        let at = Date.now() + 60000;
        if (retry && /^\d+$/.test(retry))
          at = Date.now() + Math.min(Number(retry), 86400) * 1000;
        else if (reset && /^\d+$/.test(reset))
          at = Math.max(at, Number(reset) * 1000);
        throw new PrHttpError("PR_RATE_LIMIT", new Date(at).toISOString());
      }
      if (!response.ok) throw new PrHttpError("PR_API_OUTAGE");
      if (
        Number(response.headers.get("content-length") ?? 0) >
        PR_LIMITS.httpBytes
      )
        prFail("PR_HTTP_LIMIT");
      const reader = response.body?.getReader();
      if (!reader) prFail("PR_HTTP_SCHEMA");
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > PR_LIMITS.httpBytes) prFail("PR_HTTP_LIMIT");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        prFail("PR_HTTP_SCHEMA");
      }
      this.cache.set(url, { etag: response.headers.get("etag"), body });
      return body;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  private async pages(
    path: string,
    kind: "checks" | "array",
    signal: AbortSignal,
    max: number,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let declared: number | null = null;
    for (let page = 1; page <= PR_LIMITS.pages; page++) {
      const data = (await this.get(
        path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page,
        signal,
      )) as Record<string, unknown>;
      const rows = kind === "checks" ? data?.check_runs : data;
      if (kind === "checks")
        declared = prInt(data?.total_count, PR_LIMITS.checks);
      if (!Array.isArray(rows) || rows.length > 100) prFail("PR_HTTP_SCHEMA");
      for (const x of rows) {
        if (!x || typeof x !== "object" || Array.isArray(x))
          prFail("PR_HTTP_SCHEMA");
        all.push(x as Record<string, unknown>);
      }
      if (all.length > max) prFail("PR_HTTP_LIMIT");
      if (rows.length < 100) {
        if (declared !== null && all.length !== declared)
          prFail("PR_REMOTE_GAP");
        return all;
      }
    }
    prFail("PR_REMOTE_GAP");
  }
  async snapshot(
    repo: PrRepository,
    policy: PrPolicy,
    signal: AbortSignal,
  ): Promise<PrRemoteSnapshot> {
    validatePrRepository(repo);
    const prefix =
        "/repos/" +
        encodeURIComponent(repo.owner) +
        "/" +
        encodeURIComponent(repo.name),
      pullPath = prefix + "/pulls/" + repo.number;
    const first = (await this.get(pullPath, signal)) as Record<string, any>;
    if (
      first?.number !== repo.number ||
      !["open", "closed"].includes(first.state)
    )
      prFail("PR_HTTP_SCHEMA");
    const baseRepo = first.base?.repo,
      headRepo = first.head?.repo;
    if (
      !baseRepo ||
      !headRepo ||
      String(baseRepo.owner?.login).toLowerCase() !==
        repo.owner.toLowerCase() ||
      String(baseRepo.name).toLowerCase() !== repo.name.toLowerCase()
    )
      prFail("PR_REPOSITORY_MISMATCH");
    const head = prGitSha(first.head?.sha),
      base = prGitSha(first.base?.sha),
      headIdentity = validatePrRepository({
        owner: headRepo.owner?.login,
        name: headRepo.name,
        number: repo.number,
      }),
      headPrefix =
        "/repos/" +
        encodeURIComponent(headIdentity.owner) +
        "/" +
        encodeURIComponent(headIdentity.name) +
        "/commits/" +
        head;
    const runs = await this.pages(
        headPrefix + "/check-runs?filter=all",
        "checks",
        signal,
        PR_LIMITS.checks,
      ),
      statuses = await this.pages(
        headPrefix + "/statuses",
        "array",
        signal,
        PR_LIMITS.checks,
      ),
      reviewRows = await this.pages(
        pullPath + "/reviews",
        "array",
        signal,
        PR_LIMITS.reviews,
      );
    const last = (await this.get(pullPath, signal)) as Record<string, any>;
    if (
      last.head?.sha !== head ||
      last.base?.sha !== base ||
      last.head?.repo?.id !== headRepo.id ||
      last.base?.repo?.id !== baseRepo.id ||
      last.state !== first.state
    )
      prFail("PR_HEAD_CHANGED_DURING_READ");
    const choices = new Map<string, PrCheckSnapshot>();
    for (const r of runs) {
      const id = prInt(r.id, Number.MAX_SAFE_INTEGER, 1),
        appId = prInt(
          (r.app as Record<string, unknown>)?.id,
          Number.MAX_SAFE_INTEGER,
          1,
        ),
        name = text(r.name, 128);
      if (!name || r.head_sha !== head) prFail("PR_CHECK_SHA_MISMATCH");
      if (
        ![
          "queued",
          "in_progress",
          "completed",
          "waiting",
          "requested",
          "pending",
        ].includes(String(r.status))
      )
        prFail("PR_HTTP_SCHEMA");
      // Neutral passes. A skipped run verified nothing, so it stays pending: neither green nor a repair trigger.
      const conclusion = r.conclusion === null ? null : text(r.conclusion, 64),
        state =
          r.status !== "completed" || conclusion === "skipped"
            ? "pending"
            : conclusion === "success" || conclusion === "neutral"
              ? "passed"
              : "failed";
      const key = "check:" + appId + ":" + name,
        old = choices.get(key),
        output = r.output as Record<string, unknown> | null;
      const item: PrCheckSnapshot = {
        kind: "check",
        id,
        name,
        appId,
        head,
        state,
        conclusion,
        observedRevision: r.started_at ? stamp(r.started_at) : "not-started",
        text: text(output?.summary, 256),
      };
      if (!old || id > old.id) choices.set(key, item);
    }
    for (const r of statuses) {
      const id = prInt(r.id, Number.MAX_SAFE_INTEGER, 1),
        name = text(r.context, 128);
      if (
        !name ||
        !["success", "pending", "failure", "error"].includes(String(r.state))
      )
        prFail("PR_HTTP_SCHEMA");
      const key = "status:" + name,
        old = choices.get(key);
      const item: PrCheckSnapshot = {
        kind: "status",
        id,
        name,
        appId: null,
        head,
        state:
          r.state === "success"
            ? "passed"
            : r.state === "pending"
              ? "pending"
              : "failed",
        conclusion: String(r.state),
        observedRevision: stamp(r.created_at),
        text: text(r.description, 256),
      };
      if (!old || id > old.id) choices.set(key, item);
    }
    const checks = [...choices.values()].sort((a, b) =>
      knowledgeHash([a.kind, a.name, a.appId]).localeCompare(
        knowledgeHash([b.kind, b.name, b.appId]),
      ),
    );
    const required = policy.required.map((p) => {
      const found = checks.filter(
        (c) =>
          c.kind === p.kind &&
          c.name === p.name &&
          (p.appId === null || p.appId === c.appId),
      );
      return found.length === 1 ? found[0]!.state : "missing";
    });
    const requiredState = required.includes("failed")
      ? "failed"
      : required.includes("missing")
        ? "missing"
        : required.includes("pending")
          ? "pending"
          : "passed";
    const reviewMap = new Map<number, PrReviewSnapshot>();
    for (const r of reviewRows) {
      if (r.commit_id !== head || !r.submitted_at) continue;
      const id = prInt(r.id, Number.MAX_SAFE_INTEGER, 1),
        authorId = prInt(
          (r.user as Record<string, unknown>)?.id,
          Number.MAX_SAFE_INTEGER,
          1,
        ),
        state = String(r.state);
      if (
        ![
          "APPROVED",
          "CHANGES_REQUESTED",
          "COMMENTED",
          "DISMISSED",
          "PENDING",
        ].includes(state)
      )
        prFail("PR_HTTP_SCHEMA");
      const item: PrReviewSnapshot = {
        id,
        authorId,
        head,
        state,
        submittedAt: stamp(r.submitted_at),
        body: text(r.body, 512),
      };
      if (reviewMap.has(id)) prFail("PR_REMOTE_GAP");
      reviewMap.set(id, item);
    }
    const reviews = [...reviewMap.values()].sort((a, b) => a.id - b.id),
      body = {
        version: 1 as const,
        provider: "github" as const,
        repository: repo,
        repositoryId: prInt(baseRepo.id, Number.MAX_SAFE_INTEGER, 1),
        headRepositoryId: prInt(headRepo.id, Number.MAX_SAFE_INTEGER, 1),
        headRepository: { owner: headIdentity.owner, name: headIdentity.name },
        base,
        head,
        state: first.state as "open" | "closed",
        checks,
        reviews,
        requiredState: requiredState as PrRemoteSnapshot["requiredState"],
        changesRequested: prChangesRequested(reviews),
        coverage: "complete" as const,
        mergeAuthority: false as const,
      };
    return prSign({
      ...body,
      semanticSha256: knowledgeHash(body),
      observedAt: new Date().toISOString(),
    });
  }
}
