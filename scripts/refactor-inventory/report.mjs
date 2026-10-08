import { posix } from "node:path";
import { sha256 } from "./scope.mjs";

const PUBLIC_ENTRIES = new Set([
  "packages/engine/src/index.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/v2.ts",
  "packages/windows-job/index.js",
  "packages/windows-job/index.d.ts",
  "apps/desktop/src/preload/api.ts",
]);
const WORKSPACE_ENTRIES = {
  "@moodcode/engine": "packages/engine/src/index.ts",
  "@moodcode/contracts": "packages/contracts/src/index.ts",
  "@moodcode/windows-job": "packages/windows-job/index.js",
};
export const MANUAL_GATES = [
  "Confirm actual callers and consumers, including callbacks, aliases, inheritance and computed calls.",
  "Confirm dynamic registration and string-based dispatch; spelling matches are not symbol resolution.",
  "Preserve public APIs, event contracts, DB transactions, archives and compatibility with existing records.",
  "Compare semantics and resource/cleanup ownership before extracting, merging or deleting code.",
];

function resolveModule(from, specifier, paths) {
  if (!specifier)
    return { target: null, resolution: "computed-module-manual-review" };
  if (WORKSPACE_ENTRIES[specifier]) {
    const target = WORKSPACE_ENTRIES[specifier];
    return {
      target: paths.has(target) ? target : null,
      resolution: paths.has(target)
        ? "workspace-entry"
        : "workspace-entry-not-captured",
    };
  }
  if (!specifier.startsWith("."))
    return { target: null, resolution: "external-or-alias" };
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const extension = posix.extname(base),
    stem = base.slice(0, -extension.length);
  const mapped = {
    ".js": [".ts", ".tsx", ".js", ".jsx"],
    ".mjs": [".mts", ".mjs"],
    ".cjs": [".cts", ".cjs"],
  }[extension];
  const alternatives = extension
    ? [base, ...(mapped ?? []).map((item) => `${stem}${item}`)]
    : [
        base,
        ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].flatMap((item) => [
          base + item,
          `${base}/index${item}`,
        ]),
      ];
  const targets = [...new Set(alternatives.filter((item) => paths.has(item)))];
  if (targets.length > 1)
    return {
      target: null,
      resolution: "ambiguous-relative-target",
      candidates: targets,
    };
  return {
    target: targets[0] ?? null,
    resolution: targets.length
      ? "relative-source"
      : "relative-target-not-captured",
  };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) =>
    sorted.length
      ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
      : null;
  return {
    count: sorted.length,
    total: sorted.reduce((sum, value) => sum + value, 0),
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}

function totals(files) {
  const result = {};
  for (const file of files) {
    const key = `${file.area}/${file.role}`;
    const item = (result[key] ??= {
      files: 0,
      measuredFiles: 0,
      lines: 0,
      bytes: 0,
      syntaxMeasuredFiles: 0,
      syntaxUnsupportedFiles: 0,
      syntaxFailedFiles: 0,
      functions: 0,
      imports: 0,
      exports: 0,
      calls: 0,
    });
    item.files++;
    if (file.physicalStatus === "measured") {
      item.measuredFiles++;
      item.lines += file.physicalLines;
      item.bytes += file.bytes;
    }
    if (file.syntax?.status === "measured") item.syntaxMeasuredFiles++;
    else if (file.syntax?.status === "unsupported")
      item.syntaxUnsupportedFiles++;
    else item.syntaxFailedFiles++;
    for (const field of ["functions", "imports", "exports", "calls"]) {
      item[field] += file.syntax?.[field]?.length ?? 0;
    }
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
}

function functionEvidence(file, fn, fileByPath, incoming) {
  const exports = file.syntax.exports.filter(
    (item) => item.local === fn.name || item.name === fn.name,
  );
  const sameFileCalls = file.syntax.calls.filter(
    (call) => call.spelling === fn.name && call.caller !== fn.id,
  );
  const consumers = [];
  for (const edge of incoming.get(file.path) ?? []) {
    for (const binding of edge.bindings ?? []) {
      if (exports.some((item) => item.name === binding.imported)) {
        const consumer = fileByPath.get(edge.from);
        const calls = consumer.syntax.calls.filter(
          (call) => call.spelling === binding.local,
        );
        consumers.push({
          path: edge.from,
          importLine: edge.line,
          local: binding.local,
          matchedCalls: calls.length,
          callLines: calls.slice(0, 10).map((call) => call.line),
        });
      }
    }
  }
  return {
    path: file.path,
    sourceSha256: file.sha256,
    role: file.role,
    area: file.area,
    ...fn,
    sameFileMatchedCalls: sameFileCalls.length,
    sameFileCallLines: sameFileCalls.slice(0, 10).map((call) => call.line),
    namedImportConsumers: consumers,
    exportedNames: exports.map((item) => item.name),
    knownPublicEntry: PUBLIC_ENTRIES.has(file.path),
    state: "inspection-candidate; no defect or unused-code conclusion",
  };
}

export function buildReport(capture, analysis, options, runtime) {
  const measured = new Map(analysis.records.map((item) => [item.path, item]));
  const files = capture.files.map(({ text, ...file }) => ({
    ...file,
    syntax: measured.get(file.path) ?? file.syntax,
  }));
  const owned = files.filter((file) => file.scope === "owned");
  const ancillary = files.filter((file) => file.scope !== "owned");
  const successful = owned.filter((file) => file.syntax?.status === "measured");
  const fileByPath = new Map(successful.map((file) => [file.path, file]));
  const paths = new Set(files.map((file) => file.path));
  const edges = successful.flatMap((file) =>
    file.syntax.imports.map((item) => ({
      from: file.path,
      ...item,
      ...resolveModule(file.path, item.module, paths),
    })),
  );
  const incoming = new Map();
  for (const edge of edges)
    if (edge.target) {
      const list = incoming.get(edge.target) ?? [];
      list.push(edge);
      incoming.set(edge.target, list);
    }
  const allFunctions = successful.flatMap((file) =>
    file.syntax.functions.map((fn) => ({ file, fn })),
  );
  const bySize = [...allFunctions].sort(
    (a, b) => b.fn.lines - a.fn.lines || a.fn.id.localeCompare(b.fn.id, "en"),
  );
  const byComplexity = [...allFunctions].sort(
    (a, b) =>
      b.fn.complexity - a.fn.complexity ||
      b.fn.lines - a.fn.lines ||
      a.fn.id.localeCompare(b.fn.id, "en"),
  );
  const evidence = ({ file, fn }) =>
    functionEvidence(file, fn, fileByPath, incoming);
  const groups = new Map();
  for (const item of allFunctions) {
    if (
      item.fn.bodyLines < options.duplicateMinLines ||
      item.fn.fingerprint.nodes < options.duplicateMinNodes
    )
      continue;
    const group = groups.get(item.fn.fingerprint.sha256) ?? [];
    group.push(item);
    groups.set(item.fn.fingerprint.sha256, group);
  }
  const duplicates = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([fingerprint, group]) => ({
      fingerprint,
      occurrences: group.map(({ file, fn }) => ({
        path: file.path,
        sourceSha256: file.sha256,
        role: file.role,
        id: fn.id,
        name: fn.name,
        start: fn.bodyStart,
        end: fn.bodyEnd,
        lines: fn.bodyLines,
        nodes: fn.fingerprint.nodes,
      })),
      state:
        "exact-AST-body-candidate; semantic equivalence and safe extraction unverified",
    }))
    .sort(
      (a, b) =>
        b.occurrences.length * b.occurrences[0].lines -
          a.occurrences.length * a.occurrences[0].lines ||
        a.fingerprint.localeCompare(b.fingerprint, "en"),
    );
  const failures = files
    .filter(
      (file) =>
        file.physicalStatus !== "measured" ||
        file.syntax?.status !== "measured",
    )
    .map((file) => ({
      path: file.path,
      scope: file.scope,
      physicalStatus: file.physicalStatus,
      physicalReason: file.physicalReason ?? null,
      syntaxStatus: file.syntax?.status ?? "not-measured",
      syntaxReason: file.syntax?.reason ?? null,
    }));
  const physicalFailed = owned.filter(
    (file) => file.physicalStatus !== "measured",
  ).length;
  const syntaxUnsupported = owned.filter(
    (file) => file.syntax?.status === "unsupported",
  ).length;
  const syntaxFailed = owned.length - successful.length - syntaxUnsupported;
  const complete =
    physicalFailed === 0 &&
    syntaxUnsupported === 0 &&
    syntaxFailed === 0 &&
    capture.sourceStable &&
    !capture.boundsExceeded;
  const operationalFailures =
    physicalFailed > 0 ||
    syntaxFailed > 0 ||
    !capture.sourceStable ||
    capture.boundsExceeded;
  const pins = files.map((file) => [file.path, file.sha256 ?? null]);
  const report = {
    schemaVersion: 1,
    workItem: "RF-01",
    kind: "owned-code-refactor-inventory",
    state: complete
      ? "measured; manual review outstanding"
      : operationalFailures
        ? "partial-measurement; manual review outstanding"
        : "measured-with-unsupported-syntax; manual review outstanding",
    executionStatus: operationalFailures
      ? "completed-with-measurement-failures"
      : "completed",
    complete,
    refactorAcceptance: false,
    source: {
      head: capture.head,
      indexSha256: capture.indexSha256,
      afterIndexSha256: capture.afterIndexSha256,
      afterHead: capture.afterHead,
      stable: capture.sourceStable,
      fingerprint: sha256(JSON.stringify(pins)),
      selection: "Git index tracked paths; captured working-tree bytes",
      workingTreeChangedPaths: capture.changedPaths,
      validationFailures: capture.validationFailures,
    },
    runtime,
    bounds: options,
    totals: {
      owned: {
        files: owned.length,
        measuredFiles: owned.length - physicalFailed,
        physicalLines: owned.reduce(
          (sum, file) => sum + (file.physicalLines ?? 0),
          0,
        ),
        bytes: owned.reduce((sum, file) => sum + (file.bytes ?? 0), 0),
        functions: allFunctions.length,
        imports: edges.length,
        exports: successful.reduce(
          (sum, file) => sum + file.syntax.exports.length,
          0,
        ),
        calls: successful.reduce(
          (sum, file) => sum + file.syntax.calls.length,
          0,
        ),
      },
      byAreaAndRole: totals(owned),
      ancillaryByAreaAndRole: totals(ancillary),
    },
    coverage: {
      physical: {
        attempted: owned.length,
        measured: owned.length - physicalFailed,
        failed: physicalFailed,
      },
      syntax: {
        attempted: owned.length,
        measured: successful.length,
        unsupported: syntaxUnsupported,
        failed: syntaxFailed,
      },
      ancillary: {
        files: ancillary.length,
        physicalMeasured: ancillary.filter(
          (file) => file.physicalStatus === "measured",
        ).length,
        syntaxMeasured: ancillary.filter(
          (file) => file.syntax?.status === "measured",
        ).length,
      },
      failures,
      boundsExceeded: capture.boundsExceeded,
    },
    distributions: {
      fileLines: distribution(
        owned.flatMap((file) =>
          file.physicalStatus === "measured" ? [file.physicalLines] : [],
        ),
      ),
      functionLines: distribution(allFunctions.map(({ fn }) => fn.lines)),
      functionComplexity: distribution(
        allFunctions.map(({ fn }) => fn.complexity),
      ),
    },
    candidates: {
      longestFiles: [...owned]
        .filter((file) => file.physicalStatus === "measured")
        .sort(
          (a, b) =>
            b.physicalLines - a.physicalLines ||
            a.path.localeCompare(b.path, "en"),
        )
        .slice(0, options.top)
        .map((file) => ({
          path: file.path,
          sourceSha256: file.sha256,
          lines: file.physicalLines,
          area: file.area,
          role: file.role,
          functions: file.syntax?.functions?.length ?? null,
          incomingImportSites: incoming.get(file.path)?.length ?? 0,
        })),
      longestFunctions: bySize.slice(0, options.top).map(evidence),
      mostBranchingFunctions: byComplexity.slice(0, options.top).map(evidence),
      noMatchedCall: bySize
        .filter(
          ({ file, fn }) =>
            !fn.name.startsWith("<") &&
            !file.syntax.calls.some(
              (call) => call.spelling === fn.name && call.caller !== fn.id,
            ),
        )
        .slice(0, options.top)
        .map(evidence),
      duplication: {
        totalGroups: duplicates.length,
        reportedGroups: Math.min(duplicates.length, options.top),
        groups: duplicates.slice(0, options.top),
        comparison:
          "full executable body AST structure and exact leaf spelling; trivia omitted",
      },
      manualGates: MANUAL_GATES,
    },
    graph: {
      symbolResolution: false,
      callMatching:
        "syntax spelling only; may overcount or miss aliases, shadowing and dynamic calls",
      unresolvedRelativeSites: edges.filter(
        (edge) => edge.resolution.includes("relative") && !edge.target,
      ).length,
      computedModuleSites: edges.filter((edge) => edge.module === null).length,
      edges,
    },
    exclusions: capture.exclusions,
    files: files.map((file) => {
      if (options.detail === "full" || file.syntax?.status !== "measured")
        return file;
      const { functions, calls, ...syntax } = file.syntax;
      return {
        ...file,
        syntax: {
          ...syntax,
          functionCount: functions.length,
          callCount: calls.length,
        },
      };
    }),
  };
  return report;
}
