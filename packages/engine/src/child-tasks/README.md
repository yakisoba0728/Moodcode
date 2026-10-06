# Child task 실행 계약

`ChildTaskManager({ documents, worktrees, host, cleanupTimeoutMs?, beforeDispatch? })`는 실제 모델 실행을 호스트에 위임하는 durable 실행 경계이다. `host.start`는 전달된 workspace에서 run 하나를 시작하고 `{ runId, wait, cancel }`을 반환한다. `wait`의 terminal outcome은 run의 실행·도구 효과 정리가 끝난 것을 뜻해야 한다. 비협조적 start가 늦게 handle을 반환해도 그 handle을 cancel하고 wait한다. 기본 엔진의 `EngineChildren`이 이 port를 실제 별도 MoodcodeEngine·SQLite·workspace에 연결한다.

`start` 입력은 session/request/parentRun/worktree identity, prompt, 부모의 allowedTools, 요청한 requestedTools, remainingBudget, allocation이다. prompt는 32 KiB 이내다. 도구 이름은 정확한 허용 목록의 부분집합이어야 한다. 중첩 child는 실제 running 부모의 childRunId 및 도구·예산 범위를 다시 확인한다. 깊이는 3, session task 수는 32이다. 입력은 비동기 관찰 전에 복제한다.

`ChildBudget`은 turns, toolCalls, outputBytes, durationMs를 담는다. pool은 immediate parentRunId별로 저장하고 rootRunId는 lineage를 나타낸다. root→child는 root 예산을, child→grandchild는 child의 실제 남은 예산을 예약한다. root에 descendant를 다시 청구하지 않는다. sibling 예약은 dispatch intent와 같은 CAS에 기록하며 실제 호스트는 부모 coordinator의 후속 turns/toolCalls/outputBytes 소비에서도 예약량을 차감한다. child deadline은 부모의 현재 deadline을 넘지 못한다.

모든 입력·worktree 검증과 ownership claim이 끝난 뒤 `beforeDispatch`가 마지막 부모 예약을 수행한다. hook 실패로 host.start가 호출되지 않았음을 증명하면 해당 신규 pool 예약과 owner만 되돌린다. host.start를 호출한 뒤의 취소·실패·불확실한 실행은 예약을 자동 환급하지 않는다. 이전 root-wide pool record도 자동 환급하거나 재분배하지 않는다. `EngineChildren`은 Plan/agent profile/tool policy와 context/artifact/producer/provider-attempt 상한을 상속하고, 실제 child Run 자체를 allocation으로 제한한다. 부모 tool policy는 공유하며 grant와 artifact 저장소는 별도 engine 소유다. host allowlist는 뒤늦은 tool 등록에도 유지된다.

dispatch 전 starting 기록을 저장하고 worktree ownership을 child ID로 claim한다. 부모 AbortSignal과 duration deadline은 child controller에 연결된다. cancel은 intent를 저장하고 host.cancel 및 terminal wait를 bounded하게 확인한다. 확정 terminal outcome 뒤에만 worktree owner를 release한다. dispatch 오류·wait 오류·cleanup 미확정은 uncertain이며 owner를 유지한다. `recover`는 owner를 재연결하거나 실행을 재시도하지 않는다. `close()`는 모든 live/pending handle 종료를 확인하거나 `CHILD_CLEANUP_UNCERTAIN`을 반환한다.

결과 usage가 allocation을 넘으면 accepted success로 바꾸지 않는다. journal의 결과 본문은 4 KiB 이내이며 잘리면 truncated를 표시한다. 결과 producer는 16 MiB 이내다. 전체 document는 240 KiB 이내이고 초과 저장은 오류로 드러난다. 긴 원문을 보관하려면 호스트가 artifact port를 함께 사용해야 한다.

`deliver`는 먼저 delivery pending을 저장한 뒤 `host.acceptResult`에 `child-result:<childId>`를 전달한다. 호스트는 이 requestId를 실제 durable input 경계에서 중복 제거해야 한다. receipt 손실 뒤에도 같은 ID로 재시도하며, delivered 결과를 자동 재전송하지 않는다. 서로 다른 inputId를 같은 결과의 receipt로 반환하면 거부한다. pending은 exactly-once 전달 증거가 아니다. 기본 엔진은 완료된 nested parent가 닫힌 뒤에도 결과를 원래 root session의 queue inbox에 넣는다. 결과는 명시적 관측 JSON이며 새 권한이나 현재 파일 상태의 증거로 취급하지 않는다.

`createChildMergeTool(tasks, worktrees, rootSessionId?)`는 `merge_child_changes`를 만든다. 같은 namespace의 실제 부모 run·workspace에 속하고 완료가 관찰된 child만 대상으로 삼는다. rootSessionId는 nested child가 root task/worktree 기록을 조회하는 namespace이며 실제 checkpoint의 session/run/tool owner를 바꾸지 않는다. 기준 commit과 child 파일의 차이를 Git으로 관찰하며 32개 경로/1 MiB 총 preimage+content, UTF-8 일반 text file만 지원한다. binary/symlink/custom mode/submodule·Git metadata·dependency path는 지원하지 않는다. 부모 preimage가 child 기준 SHA와 다르면 기존 patch 검증이 미리보기를 거부한다. 승인 후에도 preimage를 다시 검사한다. 실제 수정은 기존 opaque patch/승인/checkpoint 경로이며 자동 Git merge/commit은 없다. 일부 파일만 수정된 실패는 기존 patch의 partial checkpoint에 남는다.

`engine.createWorktree` 및 nested `prepareChildWorktree`는 부모 Run 시작 전에 maintenance lease 안에서 수행한다. 살아 있는 root Run 동안 준비할 수 없다. `engine.startChildTask`는 살아 있는 실제 부모 Run에만 연결되며 준비된 worktree를 요구한다. child 상태·wait/deliver는 `engine.children.tasks`, 승인은 `children.approvals/decide`로 연결한다. 부모 waitForRun의 반환만으로 child cleanup 완료를 가정하지 않고 task wait 또는 engine.close를 기다린다. `EngineChildren`의 종료 grace는 7초이며 미확정 cleanup은 owner를 유지한다. 재시작 후 host는 `children.recover(sessionId)`를 호출하고 실제 실행을 자동 재개하지 않는다.

검증은 manager의 실제 worktree·취소·dispatch/receipt·복구 경계와 기본 엔진의 parent/child/grandchild 5개, 승인한 direct/nested merge 3개 fixture를 포함한다. 각 child는 실제 독립 engine을 사용하며 예산 debit·프로파일·공유 deny 정책·취소 cleanup·중복 input·원본 Git HEAD 불변을 확인한다. 이 fixture는 실제 외부 provider 호출을 하지 않는다.
