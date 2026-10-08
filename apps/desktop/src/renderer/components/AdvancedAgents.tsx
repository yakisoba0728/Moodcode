import { useEffect, useState, useSyncExternalStore } from "react";
import type { JsonObject, JsonValue } from "@moodcode/contracts";
import type { DesktopSettings } from "../../shared/protocol.js";
import {
  number,
  object,
  rows,
  text,
  type AdvancedStore,
} from "../advanced-store.js";

const allocation = {
  turns: 2,
  toolCalls: 8,
  outputBytes: 8192,
  durationMs: 30000,
};
const shortId = (value: unknown) =>
  text(value)
    .replace(/^(?:worktree|child)_/, "")
    .slice(0, 8);
export function ChildrenPanel({
  children,
  worktrees,
  parentRunId,
  paused,
  store,
  busy,
}: {
  children: JsonValue;
  worktrees: JsonValue;
  parentRunId?: string;
  paused: boolean;
  store: AdvancedStore;
  busy: boolean;
}) {
  const [prompt, setPrompt] = useState(""),
    [selected, setSelected] = useState("");
  const trees = rows(worktrees).filter((tree) => tree.state !== "removed"),
    worktreeId = trees.some((tree) => tree.id === selected)
      ? selected
      : text(trees.at(-1)?.id);
  return (
    <section className="advanced-section">
      <h3>격리된 자식 작업</h3>
      <p className="field-help">
        부모 실행 전에 worktree를 준비하세요. 자식 작업은 현재 부모의 도구·남은
        예산 범위에서 실행돼요. worktree 정리는 부모 실행이 끝난 뒤 가능해요.
      </p>
      <button
        className="button secondary"
        disabled={busy || Boolean(parentRunId)}
        onClick={() => void store.action("worktree.create")}
      >
        worktree 준비
      </button>
      <ul className="advanced-list">
        {trees.map((tree) => (
          <li key={text(tree.id)}>
            <span>
              {shortId(tree.id)} · {text(tree.state)} · {text(tree.root)}
            </span>
            <button
              className="text-button"
              disabled={busy || Boolean(parentRunId)}
              onClick={() =>
                void store.action("worktree.cleanup", { worktreeId: tree.id! })
              }
            >
              worktree 정리
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void store.action("child.preview", {
            parentRunId: parentRunId!,
            worktreeId,
            prompt: prompt.trim(),
            tools: ["read_file"],
            allocation,
          });
        }}
      >
        <label className="field-label">
          작업 worktree
          <select
            value={worktreeId}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">선택하세요</option>
            {trees.map((tree) => (
              <option key={text(tree.id)} value={text(tree.id)}>
                {shortId(tree.id)} · {text(tree.root)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          자식 작업 요청
          <textarea
            value={prompt}
            rows={3}
            maxLength={8192}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <p className="field-help">
          읽기 전용 · 최대 2턴 / 8도구 / 출력 8KiB / 30초
        </p>
        <button
          className="button secondary"
          disabled={
            busy || paused || !parentRunId || !worktreeId || !prompt.trim()
          }
        >
          자식 작업 실행 검토
        </button>
      </form>
      <ul className="advanced-list">
        {rows(children).map((child) => {
          const resident = object(child.resident);
          const run = rows(resident.runs).at(-1);
          const usage = object(run?.usage);
          return (
            <li key={text(child.id)}>
              <div>
                <strong>
                  {shortId(child.id)} · {text(child.state)}
                </strong>
                <p>{text(object(child.outcome).content)}</p>
                {run ? (
                  <p className="field-help">
                    최근 실행 {text(run.state)} · {number(usage.turns)}턴 · 도구{" "}
                    {number(usage.toolCalls)}회 · 출력{" "}
                    {number(usage.outputBytes)}바이트
                  </p>
                ) : null}
                {child.errorCode ? <p>{text(child.errorCode)}</p> : null}
                <span className="muted">
                  엔진 {text(object(child.resident).state, "비상주")} · 부모{" "}
                  {text(child.parentRunId).slice(0, 8)} · 전달{" "}
                  {text(child.deliveryState)}
                </span>
              </div>
              {resident.state === "idle" ? (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void store.action("child.stop", { taskId: child.id! })
                  }
                >
                  자식 엔진 종료
                </button>
              ) : ["starting", "running"].includes(text(child.state)) ? (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void store.action("child.cancel", { taskId: child.id! })
                  }
                >
                  자식 작업 취소
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
export function TeamPanel({
  value,
  parentRunId,
  paused,
  store,
  busy,
}: {
  value: JsonValue;
  parentRunId?: string;
  paused: boolean;
  store: AdvancedStore;
  busy: boolean;
}) {
  const [name, setName] = useState(""),
    [teamId, setTeamId] = useState(""),
    [memberId, setMemberId] = useState(
      () =>
        "desktop-" +
        (parentRunId?.slice(0, 12) ?? crypto.randomUUID().slice(0, 8)),
    ),
    [taskTitle, setTaskTitle] = useState(""),
    [recipient, setRecipient] = useState(""),
    [message, setMessage] = useState(""),
    [detail, setDetail] = useState<JsonValue | null>(null),
    [mailbox, setMailbox] = useState<JsonValue | null>(null);
  const teams = rows(value),
    chosenId = teamId || text(object(teams.at(-1)?.team).id);
  const selectedTeam = teams.find((row) => object(row.team).id === chosenId);
  const data = object(selectedTeam ?? detail),
    members = rows(data.members),
    tasks = rows(data.tasks);
  const actor = members.find((member) => member.memberId === memberId),
    generation = number(actor?.generation, 1);
  useEffect(
    () => () => {
      const handleId = object(mailbox).handleId;
      if (typeof handleId === "string")
        void store.query("handle.release", { handleId }).catch(() => {});
    },
    [mailbox, store],
  );
  const inspect = async () => {
    const result = await store.action("team.inspect", { teamId: chosenId });
    if (result !== null) setDetail(result);
  };
  const perform = async (
    type:
      | "team.tasks.put"
      | "team.tasks.claim"
      | "team.tasks.complete"
      | "team.message.send",
    payload: JsonObject,
  ) => {
    const result = await store.action(type, {
      teamId: chosenId,
      ...(type === "team.message.send" ? {} : { memberId, generation }),
      ...payload,
    });
    if (result !== null) await inspect();
  };
  return (
    <section className="advanced-section">
      <h3>팀과 공유 작업</h3>
      <form
        className="advanced-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void store.action("team.create", {
            ...(name.trim() ? { teamId: name.trim() } : {}),
          });
        }}
      >
        <input
          aria-label="팀 이름"
          placeholder="팀 이름"
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="button secondary" disabled={busy}>
          팀 만들기
        </button>
      </form>
      <label className="field-label">
        팀 선택
        <select
          value={chosenId}
          onChange={(event) => {
            setTeamId(event.target.value);
            setDetail(null);
          }}
        >
          <option value="">선택하세요</option>
          {teams.map((team) => {
            const row = object(team.team);
            return (
              <option key={text(row.id)} value={text(row.id)}>
                {text(row.id)} · {text(row.status)}
              </option>
            );
          })}
        </select>
      </label>
      <button
        className="text-button"
        disabled={busy || !chosenId}
        onClick={() => void inspect()}
      >
        팀 상태 읽기
      </button>
      <label className="field-label">
        내 팀 구성원
        <select
          value={memberId}
          onChange={(event) => setMemberId(event.target.value)}
        >
          <option value={memberId}>
            {actor ? text(actor.memberId) : "현재 실행으로 새 구성원 참여"}
          </option>
          {members
            .filter((member) => member.memberId !== memberId)
            .map((member) => (
              <option key={text(member.id)} value={text(member.memberId)}>
                {text(member.memberId)} · {text(member.role)}
              </option>
            ))}
        </select>
      </label>
      <button
        className="button secondary"
        disabled={busy || paused || !chosenId || !memberId || !parentRunId}
        onClick={() =>
          void store.action("team.member.preview", {
            teamId: chosenId,
            memberId,
            role: "coordinator",
            expectedRevision: number(actor?.revision),
            permissions: {
              send: true,
              receive: true,
              claimTasks: true,
              manageTasks: true,
            },
          })
        }
      >
        현재 실행의 팀 참여 검토
      </button>
      <ul className="advanced-list">
        {members.map((member) => (
          <li key={text(member.id)}>
            {text(member.memberId)} · {text(member.role)} ·{" "}
            {text(member.status)}
          </li>
        ))}
      </ul>
      <form
        className="advanced-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void perform("team.tasks.put", {
            taskId: crypto.randomUUID(),
            expectedRevision: 0,
            title: taskTitle.trim(),
            description: taskTitle.trim(),
            dependencies: [],
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          }).then(() => setTaskTitle(""));
        }}
      >
        <input
          aria-label="팀 작업 제목"
          value={taskTitle}
          maxLength={256}
          onChange={(event) => setTaskTitle(event.target.value)}
        />
        <button
          className="button secondary"
          disabled={busy || !actor || !taskTitle.trim()}
        >
          팀 작업 추가
        </button>
      </form>
      <ul className="advanced-list">
        {tasks.map((task) => (
          <li key={text(task.id)}>
            <span>
              {text(task.title)} · {text(task.state)}
            </span>
            {task.state === "pending" ? (
              <button
                className="text-button"
                disabled={busy || !actor}
                onClick={() =>
                  void perform("team.tasks.claim", {
                    taskId: task.taskId!,
                    expectedRevision: number(task.revision),
                  })
                }
              >
                작업 맡기
              </button>
            ) : task.state === "claimed" ? (
              <button
                className="text-button"
                disabled={busy || !actor}
                onClick={() =>
                  void perform("team.tasks.complete", {
                    taskId: task.taskId!,
                    expectedRevision: number(task.revision),
                  })
                }
              >
                작업 완료
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const target = members.find(
            (member) => member.memberId === recipient,
          );
          void perform("team.message.send", {
            senderMemberId: memberId,
            senderGeneration: generation,
            recipientMemberId: recipient,
            recipientGeneration: number(target?.generation, 1),
            text: message.trim(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          });
        }}
      >
        <label className="field-label">
          받는 구성원
          <select
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          >
            <option value="">선택하세요</option>
            {members.map((member) => (
              <option key={text(member.id)} value={text(member.memberId)}>
                {text(member.memberId)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          팀 메시지
          <input
            value={message}
            maxLength={8192}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          disabled={busy || !actor || !recipient || !message.trim()}
        >
          메시지 전달
        </button>
      </form>
      <button
        className="text-button"
        disabled={busy || !actor}
        onClick={() =>
          void store
            .action("team.mailbox.read", {
              teamId: chosenId,
              memberId,
              generation,
            })
            .then((result) => setMailbox(result))
        }
      >
        받은 메시지 읽기
      </button>
      {mailbox ? (
        <>
          <ul className="advanced-list">
            {rows(object(object(mailbox).preview).messages).map((row) => (
              <li key={text(row.id)}>
                {text(row.senderMemberId)}: {text(row.text)}
              </li>
            ))}
          </ul>
          <button
            className="text-button"
            disabled={busy || !actor}
            onClick={() =>
              void store
                .action("team.mailbox.claim", {
                  handleId: object(mailbox).handleId!,
                  expectedCursorRevision: number(
                    object(object(object(mailbox).preview).cursor).revision,
                  ),
                })
                .then((result) => {
                  if (result !== null) setMailbox(null);
                })
            }
          >
            표시된 메시지 수신 확인
          </button>
        </>
      ) : null}
    </section>
  );
}
export function WorkflowPanel({
  value,
  worktrees,
  parentRunId,
  paused,
  settings,
  store,
  busy,
}: {
  value: JsonValue;
  worktrees: JsonValue;
  parentRunId?: string;
  paused: boolean;
  settings: DesktopSettings | null;
  store: AdvancedStore;
  busy: boolean;
}) {
  const [id, setId] = useState(""),
    [prompt, setPrompt] = useState(""),
    [workflowId, setWorkflowId] = useState(""),
    [worktreeId, setWorktreeId] = useState(""),
    [instance, setInstance] = useState<JsonValue | null>(null);
  const workflows = rows(object(value).specs),
    executions = rows(object(value).instances),
    trees = rows(worktrees).filter((tree) => tree.state !== "removed"),
    chosenId = workflowId || text(workflows.at(-1)?.workflowId);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  useEffect(() => {
    const result = object(state.result),
      record = object(result.record);
    if (typeof record.instanceId === "string") setInstance(record);
  }, [state.result]);
  const schema = {
    type: "object",
    properties: { summary: { type: "string", maxLength: 4096 } },
    required: ["summary"],
    additionalProperties: false,
  };
  const register = () =>
    store.action("workflow.register", {
      expectedRevision: 0,
      spec: {
        schemaVersion: 1,
        id: id.trim(),
        description: prompt.trim(),
        parameterSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        resultSchema: schema,
        resultStageId: "review",
        stages: [
          {
            id: "review",
            role: "advisory-reviewer",
            dependsOn: [],
            join: "all",
            prompt: `${prompt.trim()}\nReturn a JSON object with a summary string.`,
            profile: null,
            model: {
              providerId: settings?.providerId ?? "scripted",
              modelId: settings?.modelId ?? "local",
              ...(settings?.reasoningEffort
                ? { reasoningEffort: settings.reasoningEffort }
                : {}),
            },
            tools: ["read_file"],
            allocation,
            resultSchema: schema,
          },
        ],
      },
    });
  const native = object(instance ?? executions.at(-1)),
    chosenInstanceId = text(native.instanceId ?? native.id);
  const current = executions.find((row) => row.instanceId === chosenInstanceId);
  const record = current ?? (native.record ? object(native.record) : native);
  const instanceId = text(record.instanceId ?? record.id),
    stages = rows(record.stages);
  const inspect = async () => {
    const result = await store.action("workflow.inspect", { instanceId });
    if (result !== null) setInstance(result);
  };
  return (
    <section className="advanced-section">
      <h3>워크플로</h3>
      <p className="field-help">
        읽기 전용 검토 단계를 등록하고 현재 부모 실행과 준비된 worktree에
        결속해요. 결과는 관측 데이터로 표시해요.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void register();
        }}
      >
        <label className="field-label">
          워크플로 이름
          <input
            value={id}
            maxLength={128}
            onChange={(event) => setId(event.target.value)}
          />
        </label>
        <label className="field-label">
          검토 요청
          <textarea
            value={prompt}
            rows={3}
            maxLength={4096}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          disabled={busy || !id.trim() || !prompt.trim()}
        >
          워크플로 등록
        </button>
      </form>
      <label className="field-label">
        워크플로 선택
        <select
          value={chosenId}
          onChange={(event) => setWorkflowId(event.target.value)}
        >
          <option value="">선택하세요</option>
          {workflows.map((row) => (
            <option
              key={text(row.workflowId ?? row.id)}
              value={text(row.workflowId ?? row.id)}
            >
              {text(row.workflowId ?? row.id)}
            </option>
          ))}
        </select>
      </label>
      <label className="field-label">
        검토 worktree
        <select
          value={worktreeId}
          onChange={(event) => setWorktreeId(event.target.value)}
        >
          <option value="">선택하세요</option>
          {trees.map((tree) => (
            <option key={text(tree.id)} value={text(tree.id)}>
              {shortId(tree.id)} · {text(tree.root)}
            </option>
          ))}
        </select>
      </label>
      <button
        className="button secondary"
        disabled={busy || paused || !chosenId || !parentRunId || !worktreeId}
        onClick={() =>
          void store.action("workflow.preview", {
            parentRunId: parentRunId!,
            workflowId: chosenId,
            expectedSpecRevision: 1,
            parameters: {},
            stageWorktrees: { review: worktreeId },
          })
        }
      >
        워크플로 실행 검토
      </button>
      <form
        className="advanced-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <select
          aria-label="워크플로 실행 기록"
          value={instanceId}
          onChange={(event) =>
            setInstance(
              executions.find((row) => row.instanceId === event.target.value) ??
                null,
            )
          }
        >
          <option value="">선택하세요</option>
          {executions.map((execution) => (
            <option
              key={text(execution.instanceId)}
              value={text(execution.instanceId)}
            >
              {text(execution.workflowId)} · {text(execution.state)} ·{" "}
              {text(execution.createdAt)}
            </option>
          ))}
        </select>
        <button className="button secondary" disabled={busy || !instanceId}>
          실행 이력 읽기
        </button>
      </form>
      <ul className="advanced-list">
        {stages.map((stage) => (
          <li key={text(stage.stageId)}>
            <div>
              <strong>
                {text(stage.stageId)} · {text(stage.state)}
              </strong>
              {stage.result ? <p>{JSON.stringify(stage.result)}</p> : null}
            </div>
            <div className="advanced-actions">
              <button
                className="text-button"
                disabled={busy || stage.state !== "ready"}
                onClick={() =>
                  void store
                    .action("workflow.stage.start", {
                      instanceId,
                      stageId: stage.stageId!,
                      expectedRevision: number(record.revision),
                      approved: true,
                    })
                    .then((result) => setInstance(result))
                }
              >
                단계 실행 승인
              </button>
              <button
                className="text-button"
                disabled={busy || stage.state !== "running"}
                onClick={() =>
                  void store
                    .action("workflow.stage.observe", {
                      instanceId,
                      stageId: stage.stageId!,
                      expectedRevision: number(record.revision),
                    })
                    .then((result) => setInstance(result))
                }
              >
                단계 결과 읽기
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
