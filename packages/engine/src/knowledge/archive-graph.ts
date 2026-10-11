import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { identifier, KNOWLEDGE_LIMITS } from "./validation.js";

/** SQL columns that mirror the knowledge storage bodies read by producer relations. */
export const KNOWLEDGE_PRODUCER_COLUMNS = Object.freeze({
  knowledge_generation_plans: { trust_revision_id: "trustRevisionId" },
  knowledge_candidates: {
    plan_id: "planId",
    trust_revision_id: "trustRevisionId",
    generation_owner_id: "generationOwnerId",
  },
  workspace_trust_revisions: { revision: "revision" },
});
export function fieldAt(record: object, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      record,
    );
}

export type KnowledgeGraphHeader = {
  id: string;
  workspace_id: string;
  bytes: number;
  [column: string]: SQLInputValue;
};
export type KnowledgeGraphFault =
  "bound" | "changed" | "json" | "columns" | "multiple" | "missing";
export interface KnowledgeGraphOptions<Table extends string> {
  readonly columns: Readonly<Record<Table, Readonly<Record<string, string>>>>;
  readonly validate: (row: {
    table: Table;
    key: string;
    workspaceId: string;
    data: unknown;
  }) => unknown;
  readonly invalid: (fault: KnowledgeGraphFault) => never;
}

/**
 * Bounded historical row reader for archive relation validators. Statements are cached per
 * reader by SQL text, so a `headers()` iteration must not nest another with the same SQL.
 */
export function createKnowledgeGraphReader<Table extends string>(
  db: DatabaseSync,
  check: () => void,
  { columns, validate, invalid }: KnowledgeGraphOptions<Table>,
) {
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (!prepared) statements.set(sql, (prepared = db.prepare(sql)));
    return prepared;
  };
  function headers(
    table: Table,
    where = "",
    parameters: readonly SQLInputValue[] = [],
  ): Iterable<KnowledgeGraphHeader> {
    check();
    const names = Object.keys(columns[table]);
    return statement(
      `SELECT id,workspace_id,${names.length ? names.join(",") + "," : ""}length(CAST(data AS BLOB)) AS bytes FROM ${table} ${where}`,
    ).iterate(...parameters) as Iterable<KnowledgeGraphHeader>;
  }
  function read<T>(table: Table, header: KnowledgeGraphHeader): T {
    check();
    identifier(header.id);
    identifier(header.workspace_id);
    if (
      !Number.isSafeInteger(header.bytes) ||
      header.bytes < 1 ||
      header.bytes > KNOWLEDGE_LIMITS.rowBytes
    )
      return invalid("bound");
    const row = statement(
      `SELECT CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${KNOWLEDGE_LIMITS.rowBytes} THEN data END AS data FROM ${table} WHERE workspace_id=? AND id=?`,
    ).get(header.workspace_id, header.id);
    if (
      !row ||
      typeof row.data !== "string" ||
      Buffer.byteLength(row.data) !== header.bytes
    )
      return invalid("changed");
    check();
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      return invalid("json");
    }
    const data = validate({
      table,
      key: header.id,
      workspaceId: header.workspace_id,
      data: parsed,
    }) as object;
    for (const [column, path] of Object.entries(columns[table]))
      if (header[column] !== fieldAt(data, path)) invalid("columns");
    return data as T;
  }
  function one<T>(
    table: Table,
    where: string,
    parameters: readonly SQLInputValue[],
  ): T | undefined {
    let result: T | undefined;
    for (const header of headers(table, `WHERE ${where} LIMIT 2`, parameters)) {
      if (result !== undefined) invalid("multiple");
      result = read<T>(table, header);
    }
    return result;
  }
  function exact<T>(table: Table, workspaceId: string, id: string): T {
    return (
      one<T>(table, "workspace_id=? AND id=?", [workspaceId, id]) ??
      invalid("missing")
    );
  }
  return { headers, read, one, exact };
}
