# Child task 실행 계약

`ChildTaskManager({ documents, worktrees, host, cleanupTimeoutMs? })`는 실제 모델 실행을 호스트에 위임하는 durable 실행 경계이다. `host.start`는 전달된 workspace에서 run 하나를 시작하고 `{ runId, wait, cancel }`을 반환한다. `wait`의 terminal outcome은 run의 실행·도구 효과 정리가 끝난 것을 뜻해야 한다. 비협조적 start가 늦게 handle을 반환해도 그 handle을 cancel하고 wait한다.

`start` 입력은 session/request/parentRun/worktree identity, prompt, 부모의 allowedTools, 요청한 requestedTools, remainingBudget, allocation이다. prompt는 32 KiB 이내다. 도구 이름은 정확한 허용 목록의 부분집합이어야 한다. 중첩 child는 실제 running 부모의 childRunId 및 도구·예산 범위를 다시 확인한다. 깊이는 3, session task 수는 32이다. 입력은 비동기 관찰 전에 복제한다.

`ChildBudget`은 turns, toolCalls, outputBytes, durationMs를 담는다. rootRunId별 전체 pool과 모든 sibling/descendant 예약을 dispatch intent와 같은 CAS에 기록한다. 취소나 불확실한 실행도 예약을 자동 환급하지 않는다. 이 모듈의 pool만으로 부모 자신의 후속 소비까지 차단되지는 않는다. **실행 호스트는 부모 BudgetAccount에서 예약량을 차감하고 자식 run의 실제 소비를 allocation으로 제한해야 한다.** 부모 Plan/agent profile/tool policy, context/artifact/producer/provider-attempt 한도와 승인 port도 호스트가 상속해야 한다. callback 포트만 연결하고 이 조건을 누락하면 전체 실행 예산이 구현된 것으로 간주할 수 없다.

dispatch 전 starting 기록을 저장하고 worktree ownership을 child ID로 claim한다. 부모 AbortSignal과 duration deadline은 child controller에 연결된다. cancel은 intent를 저장하고 host.cancel 및 terminal wait를 bounded하게 확인한다. 확정 terminal outcome 뒤에만 worktree owner를 release한다. dispatch 오류·wait 오류·cleanup 미확정은 uncertain이며 owner를 유지한다. `recover`는 owner를 재연결하거나 실행을 재시도하지 않는다. `close()`는 모든 live/pending handle 종료를 확인하거나 `CHILD_CLEANUP_UNCERTAIN`을 반환한다.

결과 usage가 allocation을 넘으면 accepted success로 바꾸지 않는다. journal의 결과 본문은 4 KiB 이내이며 잘리면 truncated를 표시한다. 결과 producer는 16 MiB 이내다. 전체 document는 240 KiB 이내이고 초과 저장은 오류로 드러난다. 긴 원문을 보관하려면 호스트가 artifact port를 함께 사용해야 한다.

`deliver`는 먼저 delivery pending을 저장한 뒤 `host.acceptResult`에 `child-result:<childId>`를 전달한다. 호스트는 이 requestId를 실제 durable input 경계에서 중복 제거해야 한다. receipt 손실 뒤에도 같은 ID로 재시도하며, delivered 결과를 자동 재전송하지 않는다. 서로 다른 inputId를 같은 결과의 receipt로 반환하면 거부한다. pending은 exactly-once 전달 증거가 아니다.

`createChildMergeTool(tasks, worktrees)`는 `merge_child_changes`를 만든다. 같은 session·부모 run·workspace에 속하고 완료가 관찰된 child만 대상으로 삼는다. 기준 commit과 child 파일의 차이를 Git으로 관찰하며 32개 경로/1 MiB 총 preimage+content, UTF-8 일반 text file만 지원한다. binary/symlink/custom mode/submodule·Git metadata·dependency path는 지원하지 않는다. 부모 preimage가 child 기준 SHA와 다르면 기존 patch 검증이 미리보기를 거부한다. 승인 후에도 preimage를 다시 검사한다. 실제 수정은 기존 opaque patch/승인/checkpoint 경로이며 자동 Git merge/commit은 없다. 일부 파일만 수정된 실패는 기존 patch의 partial checkpoint에 남는다.

fixture 8개는 실제 worktree, 실행 중 owner cleanup 차단, 깊이/권한/공유 예약, 부모 취소, 비협조 dispatch와 late cancel, 결과 receipt 재시도, 재시작 복구, 충돌 보존 및 checkpoint merge를 확인한다. 실제 provider 호출은 하지 않는다.
