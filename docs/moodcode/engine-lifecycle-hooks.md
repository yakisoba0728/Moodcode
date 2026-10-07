# Engine lifecycle hooks

MC2-04의 첫 범위는 host가 직접 등록한 callback의 관측·거절·중단 요청이다. 구현은 `packages/engine/src/lifecycle/`에 있으며 Coordinator 실행 경계와 연결했다. 기존 `PluginToolHooks.prepared/settled`는 유지한다. workspace 파일에서 hook을 검색·설치·실행하지 않는다. 현재 callback은 모델 요청, tool arguments, credentials, opaque replay를 받지 않는다.

## Host API

```ts
const registry = new LifecycleHookRegistry();
const unregister = registry.register({
  id: 'workspace-policy',
  revision: 1,
  stages: ['tool-prepared'],
  order: 0,
  timeoutMs: 1_000,
  failurePolicy: 'stop',
  callback(invocation, signal) {
    return { kind: 'observe', metadata: { checked: true } };
  },
});
const capture = registry.capture({ workspaceId, sessionId, runId });
// registry.dispatch(capture, exactStageInvocation, runSignal)
// finally: registry.release(capture)
```

Engine을 만들 때 `EngineOptions.lifecycleHooks`에 초기 등록 목록을 전달할 수 있다. 이후 `engine.registerLifecycleHook(registration)`로 등록하고 반환된 함수로 제거한다. `EngineOptions.lifecycleHookRegistry`는 명시적인 host 공유 registry이며 초기 목록과 동시에 지정할 수 없다. 실제 owned child는 parent의 registry를 공유하지만 Run identity capture/release는 독립적이다. 생성 이후 동적으로 등록한 host policy도 child 실행 경계에 적용된다.

등록 ID는 유일하며 제거 후 재사용할 때 revision을 높여야 한다. 순서는 `order` 다음 등록 순번이다. 반환된 unregister는 자신이 등록한 generation만 제거한다. 등록 데이터와 snapshot은 detached/frozen이며 callback 함수는 snapshot descriptor에 포함되지 않는다.

Run 시작 시 capture를 한 번 만들고 종료 후 release한다. capture는 registry에 귀속된 메모리 handle이라 복사·위조·다른 registry 재사용으로 실행권이 생기지 않는다. workspace/session/run identity도 고정한다. registry 변경은 실행 전과 callback 결과 채택 전에 확인하며 stale snapshot을 새 callback으로 자동 재실행하지 않는다.

같은 `invocationId`와 정확히 같은 JSON projection은 진행 중 Promise/완료 outcome을 재사용한다. 달라진 projection은 conflict다. 이 메모리 중복 억제는 durable effect receipt나 archive/import replay 계약이 아니다.

## Stage와 제어 결과

| Stage | Metadata | 허용 결과 |
|---|---|---|
| `before-model` | provider/model, Turn index/ID, context bytes/revision, tool count, logical request SHA-256 | observe/deny/stop |
| `after-model` | provider/model, Turn/Attempt ID, finish reason, tool count, output bytes | observe/stop |
| `tool-prepared` | durable tool call ID, tool name, fingerprint, approval flag, effect class, input/preview digest | observe/deny/stop |
| `tool-settled` | durable tool call ID, tool name, outcome, output bytes, typed error/cleanup observation | observe/stop |
| `before-stop` | proposed terminal outcome, usage counters, typed error code | observe/stop |

Metadata whitelist는 stage별 scalar summary만 허용한다. 임의 입력 필드는 검증에서 거절된다. hook이 반환하는 metadata는 bounded plain JSON이다. getter, proxy, symbol, non-finite number, cycle, sparse array, 과도한 깊이/멤버 수를 허용하지 않고 detach/deep-freeze한다.

Dispatch는 `action`, `status`, bounded `outcomes[]`를 반환한다. Engine의 승인·취소·종료 상태를 직접 변경하지 않는다. observe는 실행권을 발급하지 않는다. deny는 실행 전 stage에만 가능하며, 이미 실행된 효과를 거절한 것으로 표시할 수 없다. 첫 deny/stop 결과가 이후 callback dispatch를 중단한다.

callback throw·invalid result·timeout에는 등록된 `failurePolicy`를 적용한다. 기본 정책은 stop이며 observe/deny는 host가 명시할 수 있다. 예외 메시지는 결과에 복사하지 않고 안정적인 error code만 기록한다. Run signal 취소나 release는 callback 결과 채택을 중단한다. deadline 뒤 resolve/reject는 outcome이나 중복 cache를 바꾸지 않는다.

## Bounds

| 항목 | 기본 | 설정 상한 |
|---|---:|---:|
| active hooks | 32 | 128 |
| revision을 기억하는 host IDs | 128 | 1,024 |
| invocation metadata encoded bytes | 4,096 | 65,536 |
| callback result encoded bytes | 4,096 | 65,536 |
| callback deadline ms | 1,000 | 10,000 |
| stage 전체 dispatch deadline ms | 1,000 | 30,000 |
| Run capture별 invocation IDs | 1,024 | 8,192 |

JSON depth는 8, 전체 nodes는 512, 각 array/object 멤버는 64 이하다. 각 callback은 남은 stage deadline을 공유한다. 순수 host callback을 JavaScript에서 강제 선점할 수는 없지만, 동기 callback이 deadline을 초과한 뒤 반환한 결과도 거절한다. callback deadline/abort는 외부 process·HTTP effect의 물리 종료 증거가 아니다. 외부 실행 hook은 이 port에 암묵적으로 추가하지 않는다.

## Coordinator 연결 경계

통합은 기존 Coordinator/TurnExecutor의 실행 소유권을 보존한다. 현재 연결 경계는 다음과 같다.

1. `RunCoordinator.execute()` 시작에서 Run identity capture를 생성하고 `finally`에서 release한다. `SqliteStore.commitRunObservation()`은 active Run과 정확한 Turn/Attempt scope를 검사하고 native/legacy journal에 같은 `lifecycle.outcome` payload를 한 transaction으로 남긴다. payload는 ID/revision/stage/status/action/elapsed/error code만 포함한다. callback이 반환한 metadata/reason, callback handle, 실행권은 저장/복원하지 않는다. Terminal 이후 늦은 observation은 거절한다.
2. `providerTurn()`에서 tools/messages를 detach한 logical `TurnRequest`를 만든 뒤, `owner.turn.stream()`을 시작하기 전에 `before-model`을 호출한다. SHA-256은 이 logical request projection에 대한 값이다. TurnExecutor가 만든 실제 Attempt ID/includeMetadata를 포함하는 cleanup request SHA-256과 범위를 구분한다. Hook이 요청을 변경하지 않으므로 native retry는 같은 원본 request를 유지한다. Context revision과 frozen tool catalogue도 재확인한다.
3. `after-model`은 iterator done, finish 검증, `message.completed`, `TurnExecutor.outputFinished()` 뒤에 호출한다. Hook 결과가 기존 accepted dispatch/cleanup receipt를 대신하지 않는다. 이 stage에서 stop해도 이미 완료된 Attempt와 confirmed cleanup은 유지된다.
4. `executeTool()`의 `prepare()`와 identity validation 뒤 binding을 확정한 다음, 승인 요청 전에 `tool-prepared`를 호출한다. deny는 durable tool denied 결과로 기록하고 producer를 실행하지 않는다. 승인 대기 이후에도 live/capture revision/exact prepared binding을 재검사한 뒤 효과를 실행한다. Input/preview/fingerprint를 다시 쓰지 않는다.
5. `tool-settled`는 producer의 실제 결과·checkpoint/cleanup·durable tool result를 확정한 다음에 관측한다. callback 오류가 이미 실행된 producer를 재실행하거나 결과를 덮어쓰지 않는다. cleanup uncertainty 등 기존 fatal failure가 있으면 관측 결과는 기록하되 새 action을 적용하지 않고 원래 failure를 보존한다.
6. `before-stop`은 terminal commit 이전의 제한된 관측이며 새 모델 turn을 만들지 않는다. 기존 provider/tool failure, cancel, cleanup uncertainty를 hook 실패로 덮어쓰지 않는다. Hook stop은 기존 Coordinator cancel 경로로 cancelling 상태·승인 정리를 거친다. 최종 취소·cleanup·terminal commit은 기존 Coordinator가 소유한다.

`TurnExecutor.stream()`의 request clone→cleanup row→dispatch intent→provider invocation과 retry/overflow/iterator cleanup 계약은 그대로 보존한다. Hook callback이 완료된 것과 provider/tool이 종료된 것은 각각 다른 관측이다.

## 검증과 남은 범위

`lifecycle.test.ts`의 21개 검사는 registration/revision/order, caps, Run identity/opaque capture, immutable metadata/results, duplicate invocation, failure policies, deadline, synchronous overrun, 취소/release, stale callback, late resolve/reject, stage별 metadata와 post-effect deny 거절을 확인한다.

`engine-lifecycle.test.ts`의 17개 검사는 실제 Engine/SQLite/Coordinator에서 pre-native deny의 producer/Attempt/cleanup 0, logical request digest와 동일 Turn retry, confirmed native cleanup 뒤 after-model, exact approval, durable effect/checkpoint 뒤 stop, approval 대기 중 registry 변경, cancel/timeout/late 결과, producer uncertainty 보존, capture release, eager/discovery schemas와 실제 owned child policy 상속을 확인한다. 모델은 authored synthetic adapter이며 외부 API를 호출하지 않는다.

`storage/phase-two-observations.test.ts`의 9개 검사는 두 journal의 payload/scope 일치와 실패 rollback/cursor 보존, foreign ref/terminal late receipt 거절을 확인한다. W2 준비용 active Run document publication도 CAS, cancelling/terminal owner 차단, journal 실패 시 rollback을 검사한다.

MC2-04a/b의 registry/dispatcher와 observe/deny/stop의 Coordinator 연결·native 회귀 검증을 구현했다. 가족 전체를 완료 처리하지 않는다. bounded context 변경, prepare 이전 input rewrite, verification receipt/budget을 요구하는 최대 1회 terminal continuation, 외부 command/HTTP hook의 실제 ownership·cleanup 연결은 다음 범위다.
