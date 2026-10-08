import { useState } from "react";
import {
  number,
  object,
  rows,
  text,
  type AdvancedStore,
} from "../advanced-store.js";
import type { JsonObject, JsonValue } from "@moodcode/contracts";

export function Inbox({
  control,
  inbox,
  store,
  busy,
}: {
  control: JsonValue;
  inbox: JsonValue;
  store: AdvancedStore;
  busy: boolean;
}) {
  const paused = object(control).paused === true;
  const inputs = rows(object(inbox).inputs);
  return (
    <section className="advanced-section">
      <div className="advanced-heading">
        <h3>입력 대기열</h3>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void store.action(paused ? "session.resume" : "session.pause")
          }
        >
          {paused ? "대기열 재개" : "대기열 일시정지"}
        </button>
      </div>
      <p className="field-help">
        {paused
          ? "대기열이 멈춰 있어요. 재개하면 저장된 요청을 순서대로 실행해요."
          : "Queue는 다음 실행으로, Steer는 현재 실행의 다음 안전한 턴으로 전달돼요."}
      </p>
      {inputs.length ? (
        <ul className="advanced-list">
          {inputs.map((input) => (
            <li key={text(input.id)}>
              <div>
                <strong>
                  {text(input.delivery)} · {text(input.state)}
                </strong>
                <p>{text(input.prompt)}</p>
              </div>
              {input.state === "pending" ? (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void store.action("input.cancel", { inputId: input.id! })
                  }
                >
                  요청 취소
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">저장된 요청이 없어요.</p>
      )}
      {object(inbox).nextCursor ? (
        <p className="field-help">
          최근 제한된 목록이에요. 전체 입력은 엔진에 저장돼 있어요.
        </p>
      ) : null}
    </section>
  );
}
export function Tasks({
  value,
  store,
  busy,
}: {
  value: JsonValue;
  store: AdvancedStore;
  busy: boolean;
}) {
  const [title, setTitle] = useState("");
  const data = object(value),
    tasks = rows(data.tasks);
  const replace = async (next: JsonObject[]) =>
    store.action("tasks.replace", {
      expectedRevision: number(data.revision),
      tasks: next,
    });
  return (
    <section className="advanced-section">
      <h3>작업 목록</h3>
      <form
        className="advanced-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim())
            void replace([
              ...tasks,
              {
                id: crypto.randomUUID(),
                title: title.trim(),
                status: "pending",
              },
            ]).then((result) => {
              if (result !== null) setTitle("");
            });
        }}
      >
        <input
          aria-label="새 작업 제목"
          value={title}
          maxLength={256}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="다음 할 일"
        />
        <button className="button secondary" disabled={busy || !title.trim()}>
          작업 추가
        </button>
      </form>
      <ul className="advanced-list">
        {tasks.map((task) => (
          <li key={text(task.id)}>
            <span>{text(task.title)}</span>
            <select
              aria-label={`${text(task.title)} 상태`}
              value={text(task.status)}
              disabled={busy}
              onChange={(event) =>
                void replace(
                  tasks.map((row) =>
                    row.id === task.id
                      ? { ...row, status: event.target.value }
                      : row,
                  ),
                )
              }
            >
              <option value="pending">대기</option>
              <option value="in_progress">진행</option>
              <option value="completed">완료</option>
              <option value="cancelled">취소</option>
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}
function Question({
  question,
  store,
  busy,
}: {
  question: JsonObject;
  store: AdvancedStore;
  busy: boolean;
}) {
  const [answer, setAnswer] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  const spec = object(question.spec),
    pending = question.status === "pending";
  return (
    <form
      className="advanced-question"
      onSubmit={(event) => {
        event.preventDefault();
        void store.action("question.answer", {
          questionId: question.id!,
          version: number(question.version),
          answer: {
            optionIds: selected,
            ...(answer.trim() ? { text: answer.trim() } : {}),
          },
        });
      }}
    >
      <strong>{text(spec.prompt)}</strong>
      <span className="muted">{text(question.status)}</span>
      {rows(spec.options).map((option) => (
        <label className="checkbox-label" key={text(option.id)}>
          <input
            type={spec.multiple ? "checkbox" : "radio"}
            name={text(question.id)}
            disabled={busy || !pending}
            checked={selected.includes(text(option.id))}
            onChange={(event) =>
              setSelected(
                spec.multiple
                  ? event.target.checked
                    ? [...selected, text(option.id)]
                    : selected.filter((id) => id !== option.id)
                  : [text(option.id)],
              )
            }
          />
          {text(option.label)}
        </label>
      ))}
      {spec.allowFreeText && pending ? (
        <input
          aria-label="질문 답변"
          value={answer}
          maxLength={8192}
          disabled={busy}
          onChange={(event) => setAnswer(event.target.value)}
        />
      ) : null}
      {pending ? (
        <div className="advanced-actions">
          <button
            className="button primary"
            disabled={busy || (!answer.trim() && !selected.length)}
          >
            답변 전달
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void store.action("question.reject", {
                questionId: question.id!,
                version: number(question.version),
              })
            }
          >
            질문 거절
          </button>
        </div>
      ) : question.answer ? (
        <p>{JSON.stringify(question.answer)}</p>
      ) : null}
    </form>
  );
}
export function Questions({
  value,
  store,
  busy,
}: {
  value: JsonValue;
  store: AdvancedStore;
  busy: boolean;
}) {
  const questions = rows(value);
  return (
    <section className="advanced-section">
      <h3>확인할 질문</h3>
      {questions.length ? (
        questions.map((question) => (
          <Question
            key={`${text(question.id)}:${number(question.version)}`}
            question={question}
            store={store}
            busy={busy}
          />
        ))
      ) : (
        <p className="muted">대기 중인 질문이 없어요.</p>
      )}
    </section>
  );
}
