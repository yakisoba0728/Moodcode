// Frozen from the pre-migration v1 writer. Do not regenerate from the current store.
export const V1_DATABASE_FIXTURE = {
  "baselineCommit": "9614c39cb27e60478fd61ca7e3184f8091414de6",
  "rootPlaceholder": "/__moodcode_v1_fixture__",
  "ids": {
    "sessionId": "v1-session",
    "workspaceId": "v1-workspace",
    "terminalRunId": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
    "activeRunId": "5bf71071-5030-42d6-b452-46ba893ed441",
    "checkpointId": "v1-patch-checkpoint",
    "activeCheckpointId": "v1-incomplete-checkpoint"
  },
  "primary": {
    "version": 1,
    "applicationId": 0,
    "schema": [
      {
        "type": "table",
        "name": "workspaces",
        "tbl_name": "workspaces",
        "sql": "CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL) STRICT"
      },
      {
        "type": "table",
        "name": "sessions",
        "tbl_name": "sessions",
        "sql": "CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq >= 0), data TEXT NOT NULL) STRICT"
      },
      {
        "type": "table",
        "name": "inputs",
        "tbl_name": "inputs",
        "sql": "CREATE TABLE inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, admitted_seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, request_id)) STRICT"
      },
      {
        "type": "table",
        "name": "runs",
        "tbl_name": "runs",
        "sql": "CREATE TABLE runs (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL UNIQUE REFERENCES inputs(id), session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), state TEXT NOT NULL CHECK(state IN ('created','running','awaiting_approval','cancelling','completed','cancelled','failed','interrupted')), data TEXT NOT NULL) STRICT"
      },
      {
        "type": "index",
        "name": "one_active_run_per_workspace",
        "tbl_name": "runs",
        "sql": "CREATE UNIQUE INDEX one_active_run_per_workspace ON runs(workspace_id) WHERE state IN ('created','running','awaiting_approval','cancelling')"
      },
      {
        "type": "table",
        "name": "messages",
        "tbl_name": "messages",
        "sql": "CREATE TABLE messages (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL) STRICT"
      },
      {
        "type": "table",
        "name": "tools",
        "tbl_name": "tools",
        "sql": "CREATE TABLE tools (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL, data TEXT NOT NULL) STRICT"
      },
      {
        "type": "table",
        "name": "approvals",
        "tbl_name": "approvals",
        "sql": "CREATE TABLE approvals (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), tool_call_id TEXT NOT NULL REFERENCES tools(id), status TEXT NOT NULL, data TEXT NOT NULL) STRICT"
      },
      {
        "type": "table",
        "name": "checkpoints",
        "tbl_name": "checkpoints",
        "sql": "CREATE TABLE checkpoints (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), tool_call_id TEXT NOT NULL REFERENCES tools(id), data TEXT NOT NULL) STRICT"
      },
      {
        "type": "table",
        "name": "events",
        "tbl_name": "events",
        "sql": "CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL CHECK(seq > 0), event_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, seq)) STRICT"
      },
      {
        "type": "index",
        "name": "runs_session",
        "tbl_name": "runs",
        "sql": "CREATE INDEX runs_session ON runs(session_id, ordinal)"
      },
      {
        "type": "index",
        "name": "messages_session",
        "tbl_name": "messages",
        "sql": "CREATE INDEX messages_session ON messages(session_id, ordinal)"
      },
      {
        "type": "index",
        "name": "tools_session",
        "tbl_name": "tools",
        "sql": "CREATE INDEX tools_session ON tools(session_id, ordinal)"
      },
      {
        "type": "index",
        "name": "approvals_session",
        "tbl_name": "approvals",
        "sql": "CREATE INDEX approvals_session ON approvals(session_id, ordinal)"
      },
      {
        "type": "index",
        "name": "checkpoints_run",
        "tbl_name": "checkpoints",
        "sql": "CREATE INDEX checkpoints_run ON checkpoints(run_id, ordinal)"
      }
    ],
    "tables": [
      {
        "name": "workspaces",
        "rows": [
          {
            "id": "v1-workspace",
            "root": "/__moodcode_v1_fixture__",
            "data": "{\"id\":\"v1-workspace\",\"root\":\"/__moodcode_v1_fixture__\",\"gitRoot\":\"/__moodcode_v1_fixture__\",\"branch\":\"fixture\",\"createdAt\":\"2026-10-07T00:00:00.000Z\"}"
          }
        ]
      },
      {
        "name": "sessions",
        "rows": [
          {
            "id": "v1-session",
            "workspace_id": "v1-workspace",
            "last_seq": 14,
            "data": "{\"id\":\"v1-session\",\"workspaceId\":\"v1-workspace\",\"title\":\"Frozen v1 history\",\"createdAt\":\"2026-10-07T00:00:00.000Z\"}"
          }
        ]
      },
      {
        "name": "inputs",
        "rows": [
          {
            "id": "401e4de9-ff94-48ab-9087-1cad4e3dd9ab",
            "session_id": "v1-session",
            "request_id": "v1-terminal-request",
            "fingerprint": "{\"config\":{\"limits\":{\"maxContextBytes\":262144,\"maxDurationMs\":300000,\"maxOutputBytes\":65536,\"maxToolCalls\":32,\"maxTurns\":12,\"toolTimeoutMs\":60000},\"mode\":\"build\",\"modelId\":\"local\",\"providerId\":\"scripted\"},\"prompt\":\"Preserve the durable v1 coding result\",\"requestId\":\"v1-terminal-request\",\"sessionId\":\"v1-session\"}",
            "admitted_seq": 1,
            "data": "{\"sessionId\":\"v1-session\",\"requestId\":\"v1-terminal-request\",\"prompt\":\"Preserve the durable v1 coding result\",\"config\":{\"providerId\":\"scripted\",\"modelId\":\"local\",\"mode\":\"build\",\"limits\":{\"maxTurns\":12,\"maxToolCalls\":32,\"maxDurationMs\":300000,\"toolTimeoutMs\":60000,\"maxOutputBytes\":65536,\"maxContextBytes\":262144}}}"
          },
          {
            "id": "c8ce8823-f054-4bb5-8085-bc563a499e1b",
            "session_id": "v1-session",
            "request_id": "v1-active-request",
            "fingerprint": "{\"config\":{\"limits\":{\"maxContextBytes\":262144,\"maxDurationMs\":300000,\"maxOutputBytes\":65536,\"maxToolCalls\":32,\"maxTurns\":12,\"toolTimeoutMs\":60000},\"mode\":\"build\",\"modelId\":\"local\",\"providerId\":\"scripted\"},\"prompt\":\"Outcome is unknown: never replay this command automatically\",\"requestId\":\"v1-active-request\",\"sessionId\":\"v1-session\"}",
            "admitted_seq": 12,
            "data": "{\"sessionId\":\"v1-session\",\"requestId\":\"v1-active-request\",\"prompt\":\"Outcome is unknown: never replay this command automatically\",\"config\":{\"providerId\":\"scripted\",\"modelId\":\"local\",\"mode\":\"build\",\"limits\":{\"maxTurns\":12,\"maxToolCalls\":32,\"maxDurationMs\":300000,\"toolTimeoutMs\":60000,\"maxOutputBytes\":65536,\"maxContextBytes\":262144}}}"
          }
        ]
      },
      {
        "name": "runs",
        "rows": [
          {
            "ordinal": 1,
            "id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "input_id": "401e4de9-ff94-48ab-9087-1cad4e3dd9ab",
            "session_id": "v1-session",
            "workspace_id": "v1-workspace",
            "state": "completed",
            "data": "{\"id\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"inputId\":\"401e4de9-ff94-48ab-9087-1cad4e3dd9ab\",\"sessionId\":\"v1-session\",\"workspaceId\":\"v1-workspace\",\"requestId\":\"v1-terminal-request\",\"prompt\":\"Preserve the durable v1 coding result\",\"config\":{\"providerId\":\"scripted\",\"modelId\":\"local\",\"mode\":\"build\",\"limits\":{\"maxTurns\":12,\"maxToolCalls\":32,\"maxDurationMs\":300000,\"toolTimeoutMs\":60000,\"maxOutputBytes\":65536,\"maxContextBytes\":262144}},\"state\":\"completed\",\"createdAt\":\"2026-10-06T17:31:55.484Z\",\"updatedAt\":\"2026-10-06T17:31:55.487Z\"}"
          },
          {
            "ordinal": 2,
            "id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "input_id": "c8ce8823-f054-4bb5-8085-bc563a499e1b",
            "session_id": "v1-session",
            "workspace_id": "v1-workspace",
            "state": "awaiting_approval",
            "data": "{\"id\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"inputId\":\"c8ce8823-f054-4bb5-8085-bc563a499e1b\",\"sessionId\":\"v1-session\",\"workspaceId\":\"v1-workspace\",\"requestId\":\"v1-active-request\",\"prompt\":\"Outcome is unknown: never replay this command automatically\",\"config\":{\"providerId\":\"scripted\",\"modelId\":\"local\",\"mode\":\"build\",\"limits\":{\"maxTurns\":12,\"maxToolCalls\":32,\"maxDurationMs\":300000,\"toolTimeoutMs\":60000,\"maxOutputBytes\":65536,\"maxContextBytes\":262144}},\"state\":\"awaiting_approval\",\"createdAt\":\"2026-10-06T17:31:55.487Z\",\"updatedAt\":\"2026-10-06T17:31:55.488Z\"}"
          }
        ]
      },
      {
        "name": "messages",
        "rows": [
          {
            "ordinal": 1,
            "id": "dab397d9-0380-410d-8383-e36034cd6c94",
            "session_id": "v1-session",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "data": "{\"id\":\"dab397d9-0380-410d-8383-e36034cd6c94\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"role\":\"user\",\"content\":\"Preserve the durable v1 coding result\",\"createdAt\":\"2026-10-06T17:31:55.484Z\"}"
          },
          {
            "ordinal": 2,
            "id": "v1-assistant",
            "session_id": "v1-session",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "data": "{\"id\":\"v1-assistant\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"role\":\"assistant\",\"content\":\"Stored Korean result: 완료\",\"createdAt\":\"2026-10-07T00:00:00.000Z\",\"providerReplay\":{\"providerId\":\"scripted\",\"items\":[{\"type\":\"reasoning\",\"id\":\"v1-reasoning\",\"encrypted_content\":\"fixture-opaque-state\"}]}}"
          },
          {
            "ordinal": 3,
            "id": "a46438a8-6521-457a-ac35-fb1c3ef2398c",
            "session_id": "v1-session",
            "run_id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "data": "{\"id\":\"a46438a8-6521-457a-ac35-fb1c3ef2398c\",\"sessionId\":\"v1-session\",\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"role\":\"user\",\"content\":\"Outcome is unknown: never replay this command automatically\",\"createdAt\":\"2026-10-06T17:31:55.487Z\"}"
          }
        ]
      },
      {
        "name": "tools",
        "rows": [
          {
            "ordinal": 1,
            "id": "v1-patch-tool",
            "session_id": "v1-session",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "state": "completed",
            "data": "{\"id\":\"v1-patch-tool\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"name\":\"apply_patch\",\"input\":{\"path\":\"kept.txt\"},\"state\":\"completed\",\"output\":\"stored outcome\"}"
          },
          {
            "ordinal": 2,
            "id": "v1-terminal-unresolved-tool",
            "session_id": "v1-session",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "state": "requested",
            "data": "{\"id\":\"v1-terminal-unresolved-tool\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"name\":\"run_command\",\"input\":{\"command\":\"fixture; never execute\"},\"state\":\"requested\"}"
          },
          {
            "ordinal": 3,
            "id": "v1-active-tool",
            "session_id": "v1-session",
            "run_id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "state": "awaiting_approval",
            "data": "{\"id\":\"v1-active-tool\",\"sessionId\":\"v1-session\",\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"name\":\"run_command\",\"input\":{\"command\":\"fixture unknown effect; never execute\"},\"state\":\"awaiting_approval\"}"
          }
        ]
      },
      {
        "name": "approvals",
        "rows": [
          {
            "ordinal": 1,
            "id": "v1-allowed-approval",
            "session_id": "v1-session",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "tool_call_id": "v1-patch-tool",
            "status": "allowed",
            "data": "{\"id\":\"v1-allowed-approval\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"toolCallId\":\"v1-patch-tool\",\"toolName\":\"apply_patch\",\"fingerprint\":\"3f7267c040da4b3f3271d2a2d6b0c075ca31804d832b86030856fa85adbf7748\",\"preview\":{\"path\":\"kept.txt\",\"before\":\"user content\\n\",\"after\":\"engine content\\n\"},\"status\":\"allowed\",\"createdAt\":\"2026-10-07T00:00:00.000Z\",\"resolvedAt\":\"2026-10-07T00:00:00.000Z\"}"
          },
          {
            "ordinal": 2,
            "id": "v1-terminal-expired-approval",
            "session_id": "v1-session",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "tool_call_id": "v1-terminal-unresolved-tool",
            "status": "expired",
            "data": "{\"id\":\"v1-terminal-expired-approval\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"toolCallId\":\"v1-terminal-unresolved-tool\",\"toolName\":\"run_command\",\"fingerprint\":\"9b728d1dd41be1e37b95f4c42fa0922463f7127ec44ea3286511432df5f27dd8\",\"preview\":{\"command\":\"fixture; never execute\"},\"status\":\"expired\",\"createdAt\":\"2026-10-07T00:00:00.000Z\",\"resolvedAt\":\"2026-10-06T17:31:55.487Z\"}"
          },
          {
            "ordinal": 3,
            "id": "v1-pending-approval",
            "session_id": "v1-session",
            "run_id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "tool_call_id": "v1-active-tool",
            "status": "pending",
            "data": "{\"id\":\"v1-pending-approval\",\"sessionId\":\"v1-session\",\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"toolCallId\":\"v1-active-tool\",\"toolName\":\"run_command\",\"fingerprint\":\"f6681f5cdd6976590590362dc2c9af896733f19d34ae1d0ba5bae3e0ed814ee7\",\"preview\":{\"command\":\"fixture unknown effect; never execute\"},\"status\":\"pending\",\"createdAt\":\"2026-10-07T00:00:00.000Z\"}"
          }
        ]
      },
      {
        "name": "checkpoints",
        "rows": [
          {
            "ordinal": 1,
            "id": "v1-patch-checkpoint",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "tool_call_id": "v1-patch-tool",
            "data": "{\"id\":\"v1-patch-checkpoint\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"toolCallId\":\"v1-patch-tool\",\"kind\":\"patch\",\"createdAt\":\"2026-10-07T00:00:00.000Z\",\"files\":[{\"path\":\"kept.txt\",\"before\":\"user content\\n\",\"after\":\"engine content\\n\",\"beforeHash\":\"988d6cef705f5373c95c93fd3e5ad7be3d2dfcd55d1c2d958da71654e9781c01\",\"afterHash\":\"6afb7ed5bb6adf670620cdfd4dbf48538ae58e92f7a8b9f2a49b1425b3c267a9\"}],\"warnings\":[\"Fixture captures only recorded effects\"]}"
          },
          {
            "ordinal": 2,
            "id": "v1-incomplete-checkpoint",
            "run_id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "tool_call_id": "v1-active-tool",
            "data": "{\"id\":\"v1-incomplete-checkpoint\",\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"toolCallId\":\"v1-active-tool\",\"kind\":\"command\",\"createdAt\":\"2026-10-07T00:00:00.000Z\",\"files\":[],\"warnings\":[\"Outcome is unknown\"],\"incomplete\":true}"
          }
        ]
      },
      {
        "name": "events",
        "rows": [
          {
            "session_id": "v1-session",
            "seq": 1,
            "event_id": "ac31ee39-4548-44d1-91b2-723a0f6d87e4",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "input.admitted",
            "data": "{\"schemaVersion\":1,\"eventId\":\"ac31ee39-4548-44d1-91b2-723a0f6d87e4\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":1,\"timestamp\":\"2026-10-06T17:31:55.485Z\",\"type\":\"input.admitted\",\"payload\":{\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"inputId\":\"401e4de9-ff94-48ab-9087-1cad4e3dd9ab\",\"requestId\":\"v1-terminal-request\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 2,
            "event_id": "637a4e31-8bcd-47a1-b4ae-a39ade9d92f6",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "run.started",
            "data": "{\"schemaVersion\":1,\"eventId\":\"637a4e31-8bcd-47a1-b4ae-a39ade9d92f6\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":2,\"timestamp\":\"2026-10-06T17:31:55.485Z\",\"type\":\"run.started\",\"payload\":{}}"
          },
          {
            "session_id": "v1-session",
            "seq": 3,
            "event_id": "d7c09893-6ea2-4ed4-8222-951670f32969",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "message.delta",
            "data": "{\"schemaVersion\":1,\"eventId\":\"d7c09893-6ea2-4ed4-8222-951670f32969\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":3,\"timestamp\":\"2026-10-06T17:31:55.485Z\",\"type\":\"message.delta\",\"payload\":{\"delta\":\"Stored Korean result: 완료\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 4,
            "event_id": "5fadab7b-ef74-4c03-a945-f98c1648d6e2",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "approval.requested",
            "data": "{\"schemaVersion\":1,\"eventId\":\"5fadab7b-ef74-4c03-a945-f98c1648d6e2\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":4,\"timestamp\":\"2026-10-06T17:31:55.486Z\",\"type\":\"approval.requested\",\"payload\":{\"approvalId\":\"v1-allowed-approval\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 5,
            "event_id": "97c057aa-438f-46c0-84f6-fad753be9c1a",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "approval.resolved",
            "data": "{\"schemaVersion\":1,\"eventId\":\"97c057aa-438f-46c0-84f6-fad753be9c1a\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":5,\"timestamp\":\"2026-10-06T17:31:55.486Z\",\"type\":\"approval.resolved\",\"payload\":{\"approvalId\":\"v1-allowed-approval\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 6,
            "event_id": "7fae55b7-3ffd-4ea1-865e-14720f554eb6",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "tool.started",
            "data": "{\"schemaVersion\":1,\"eventId\":\"7fae55b7-3ffd-4ea1-865e-14720f554eb6\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":6,\"timestamp\":\"2026-10-06T17:31:55.486Z\",\"type\":\"tool.started\",\"payload\":{\"toolCallId\":\"v1-patch-tool\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 7,
            "event_id": "0a4f9151-d6bb-4025-925e-3129dbd4ac35",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "checkpoint.recorded",
            "data": "{\"schemaVersion\":1,\"eventId\":\"0a4f9151-d6bb-4025-925e-3129dbd4ac35\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":7,\"timestamp\":\"2026-10-06T17:31:55.486Z\",\"type\":\"checkpoint.recorded\",\"payload\":{\"checkpointId\":\"v1-patch-checkpoint\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 8,
            "event_id": "d8633c91-631d-4d0f-a893-df949ef9ab0b",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "tool.completed",
            "data": "{\"schemaVersion\":1,\"eventId\":\"d8633c91-631d-4d0f-a893-df949ef9ab0b\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":8,\"timestamp\":\"2026-10-06T17:31:55.487Z\",\"type\":\"tool.completed\",\"payload\":{\"toolCallId\":\"v1-patch-tool\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 9,
            "event_id": "c94cf4cf-ffc6-43e1-b848-b54689d4f4d8",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "approval.requested",
            "data": "{\"schemaVersion\":1,\"eventId\":\"c94cf4cf-ffc6-43e1-b848-b54689d4f4d8\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":9,\"timestamp\":\"2026-10-06T17:31:55.487Z\",\"type\":\"approval.requested\",\"payload\":{\"approvalId\":\"v1-terminal-expired-approval\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 10,
            "event_id": "1248fd8c-aff1-48fb-9fef-14dbac6dfe29",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "approval.expired",
            "data": "{\"schemaVersion\":1,\"eventId\":\"1248fd8c-aff1-48fb-9fef-14dbac6dfe29\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":10,\"timestamp\":\"2026-10-06T17:31:55.487Z\",\"type\":\"approval.expired\",\"payload\":{\"approvalId\":\"v1-terminal-expired-approval\",\"toolCallId\":\"v1-terminal-unresolved-tool\",\"toolName\":\"run_command\",\"status\":\"expired\",\"reason\":\"run_terminal\",\"approval\":{\"id\":\"v1-terminal-expired-approval\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"toolCallId\":\"v1-terminal-unresolved-tool\",\"toolName\":\"run_command\",\"fingerprint\":\"9b728d1dd41be1e37b95f4c42fa0922463f7127ec44ea3286511432df5f27dd8\",\"preview\":{\"command\":\"fixture; never execute\"},\"status\":\"expired\",\"createdAt\":\"2026-10-07T00:00:00.000Z\",\"resolvedAt\":\"2026-10-06T17:31:55.487Z\"}}}"
          },
          {
            "session_id": "v1-session",
            "seq": 11,
            "event_id": "006fc454-c2a4-4c67-9879-c58a3cff6c5d",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "type": "run.completed",
            "data": "{\"schemaVersion\":1,\"eventId\":\"006fc454-c2a4-4c67-9879-c58a3cff6c5d\",\"sessionId\":\"v1-session\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"seq\":11,\"timestamp\":\"2026-10-06T17:31:55.487Z\",\"type\":\"run.completed\",\"payload\":{\"state\":\"completed\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 12,
            "event_id": "025f3b7e-d987-4692-bdb3-a2640283961e",
            "run_id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "type": "input.admitted",
            "data": "{\"schemaVersion\":1,\"eventId\":\"025f3b7e-d987-4692-bdb3-a2640283961e\",\"sessionId\":\"v1-session\",\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"seq\":12,\"timestamp\":\"2026-10-06T17:31:55.487Z\",\"type\":\"input.admitted\",\"payload\":{\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"inputId\":\"c8ce8823-f054-4bb5-8085-bc563a499e1b\",\"requestId\":\"v1-active-request\"}}"
          },
          {
            "session_id": "v1-session",
            "seq": 13,
            "event_id": "a7f39015-8b88-4938-b429-805f546e934b",
            "run_id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "type": "run.started",
            "data": "{\"schemaVersion\":1,\"eventId\":\"a7f39015-8b88-4938-b429-805f546e934b\",\"sessionId\":\"v1-session\",\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"seq\":13,\"timestamp\":\"2026-10-06T17:31:55.487Z\",\"type\":\"run.started\",\"payload\":{}}"
          },
          {
            "session_id": "v1-session",
            "seq": 14,
            "event_id": "f962d45a-16ff-4cc3-bc03-6670bd071c95",
            "run_id": "5bf71071-5030-42d6-b452-46ba893ed441",
            "type": "approval.requested",
            "data": "{\"schemaVersion\":1,\"eventId\":\"f962d45a-16ff-4cc3-bc03-6670bd071c95\",\"sessionId\":\"v1-session\",\"runId\":\"5bf71071-5030-42d6-b452-46ba893ed441\",\"seq\":14,\"timestamp\":\"2026-10-06T17:31:55.488Z\",\"type\":\"approval.requested\",\"payload\":{\"approvalId\":\"v1-pending-approval\"}}"
          }
        ]
      }
    ]
  },
  "review": {
    "version": 1,
    "applicationId": 1296257610,
    "schema": [
      {
        "type": "table",
        "name": "review_operations",
        "tbl_name": "review_operations",
        "sql": "CREATE TABLE review_operations ( ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, checkpoint_id TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','completed','failed','interrupted')), started_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT, outcome_hash TEXT, CHECK(result IS NULL OR length(CAST(result AS BLOB)) <= 131072), CHECK(error IS NULL OR length(CAST(error AS BLOB)) <= 32768), CHECK((state='started' AND finished_at IS NULL AND result IS NULL AND error IS NULL AND outcome_hash IS NULL) OR (state='completed' AND finished_at IS NOT NULL AND result IS NOT NULL AND error IS NULL AND outcome_hash IS NOT NULL) OR (state IN ('failed','interrupted') AND finished_at IS NOT NULL AND result IS NULL AND error IS NOT NULL AND outcome_hash IS NOT NULL)) ) STRICT"
      },
      {
        "type": "index",
        "name": "review_operations_run",
        "tbl_name": "review_operations",
        "sql": "CREATE INDEX review_operations_run ON review_operations(run_id, ordinal DESC)"
      }
    ],
    "tables": [
      {
        "name": "review_operations",
        "rows": [
          {
            "ordinal": 1,
            "id": "v1-completed-restore",
            "checkpoint_id": "v1-patch-checkpoint",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "session_id": "v1-session",
            "workspace_id": "v1-workspace",
            "fingerprint": "ee30da87895d74cbb41dce4f0cd9cfe99416f490183eb8da512ef885e1f140f4",
            "state": "completed",
            "started_at": "2026-10-06T17:31:55.502Z",
            "finished_at": "2026-10-06T17:31:55.512Z",
            "result": "{\"checkpointId\":\"v1-patch-checkpoint\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"atomic\":false,\"restored\":[\"kept.txt\"],\"conflicts\":[],\"failed\":[],\"warnings\":[],\"observations\":[{\"path\":\"kept.txt\",\"state\":\"present\",\"currentHash\":\"988d6cef705f5373c95c93fd3e5ad7be3d2dfcd55d1c2d958da71654e9781c01\",\"bytes\":13}],\"cancelled\":false,\"effectsUncertain\":false,\"executionBlocked\":false,\"truncated\":false,\"totals\":{\"restored\":1,\"conflicts\":0,\"failed\":0,\"observations\":1,\"warnings\":0}}",
            "error": null,
            "outcome_hash": "4b19bd6cc4ac0644a5bf81ccf20616fdd01648469a806fd63065e7663e20f69a"
          },
          {
            "ordinal": 2,
            "id": "v1-acknowledged-restore",
            "checkpoint_id": "v1-patch-checkpoint",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "session_id": "v1-session",
            "workspace_id": "v1-workspace",
            "fingerprint": "ee30da87895d74cbb41dce4f0cd9cfe99416f490183eb8da512ef885e1f140f4",
            "state": "interrupted",
            "started_at": "2026-10-06T17:31:55.524Z",
            "finished_at": "2026-10-06T17:31:55.535Z",
            "result": null,
            "error": "{\"code\":\"RESTORE_INTERRUPTED\",\"message\":\"Restoration did not record a final outcome; filesystem effects are unknown. Reconcile the workspace before further effects.\"}",
            "outcome_hash": "6fd3e9ebc52487b29d544b1c1116385c7a788cf8fae247da739f4b91a60fae45"
          },
          {
            "ordinal": 3,
            "id": "v1-unfinished-restore",
            "checkpoint_id": "v1-patch-checkpoint",
            "run_id": "19d8205c-49c1-4167-b2e1-7d25bc86cf7d",
            "session_id": "v1-session",
            "workspace_id": "v1-workspace",
            "fingerprint": "ee30da87895d74cbb41dce4f0cd9cfe99416f490183eb8da512ef885e1f140f4",
            "state": "started",
            "started_at": "2026-10-06T17:31:55.548Z",
            "finished_at": null,
            "result": null,
            "error": null,
            "outcome_hash": null
          }
        ]
      }
    ]
  },
  "ledger": {
    "version": 1,
    "applicationId": 1296257612,
    "schema": [
      {
        "type": "table",
        "name": "recovery_audit",
        "tbl_name": "recovery_audit",
        "sql": "CREATE TABLE recovery_audit (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 4194304)) STRICT"
      }
    ],
    "tables": [
      {
        "name": "recovery_audit",
        "rows": [
          {
            "ordinal": 1,
            "id": "v1-recovery-audit",
            "data": "{\"id\":\"v1-recovery-audit\",\"fingerprint\":\"4a11b64944bf9744d94d65db9378053e5b02070644d70d68bb1015535b11efb2\",\"scope\":\"5cc60571ab7ca76bd94fa677ac1e74a7bad04568dcf8d92a15579cdb56fbf008\",\"acknowledgedAt\":\"2026-10-07T00:00:00.000Z\",\"markerClearRequested\":false,\"markerHash\":null,\"backups\":{\"primary\":{\"bytes\":4096,\"schemaVersion\":1,\"sha256\":\"811f16bde11410c94febcee8698c7912d5edc9c5b01d1c2f9786402eb0405339\"},\"review\":{\"bytes\":4096,\"schemaVersion\":1,\"sha256\":\"0b42506b8e1c24b2b8528f26119ad1a281b0d0f2a74a560bef7e00e433a779c8\"}},\"acknowledgments\":[{\"id\":\"v1-acknowledged-restore\",\"checkpointId\":\"v1-patch-checkpoint\",\"runId\":\"19d8205c-49c1-4167-b2e1-7d25bc86cf7d\",\"sessionId\":\"v1-session\",\"workspaceId\":\"v1-workspace\",\"fingerprint\":\"ee30da87895d74cbb41dce4f0cd9cfe99416f490183eb8da512ef885e1f140f4\",\"state\":\"interrupted\",\"outcomeHash\":\"6fd3e9ebc52487b29d544b1c1116385c7a788cf8fae247da739f4b91a60fae45\",\"operationHash\":\"421883b3e859c2ddb5e82249ea293a922bfe4d44cc44e2a32a6c0365f1a21a58\"}]}"
          }
        ]
      }
    ]
  }
} as const;
