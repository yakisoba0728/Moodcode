# Moodcode typed lifecycle 변환과 검증 기반 이어가기

MC2-04c/d를 실제 Engine, eager/discovery 도구, ContextRevision, native Run/Turn/Attempt와 연결한다. 기존 registry의 ID/revision/order/failure policy, 원본 capture, 취소·callback deadline·late result 규칙을 사용한다. callback은 host가 명시적으로 등록하며 저장소에서 발견한 파일을 실행하지 않는다.

`tool-prepare`는 실제 `prepare` 직전이다. callback에는 이름·owner·입력 해시/크기만 전달한다. `rewrite-input`은 현재 해시에 묶인 전체 JSON 입력이며 순서가 있는 다음 hook은 새 해시를 받는다. 원본 model proposal과 tool call ID/name을 보존하고, 마지막 입력으로 prepare를 한 번만 실행한다. 준비한 opaque handle, 최종 fingerprint와 preview에 정확한 승인을 요청한다. 승인 뒤 handle·정책·catalogue·registry 변경은 실행 전에 거절한다. 변환 trace와 `lifecycle.outcome`에는 원문 대신 해시를 기록한다.

`model-context`는 최종 ContextRevision과 native Turn을 만들기 전이다. 해당 stage 등록이 opt-in이며 `lifecycleContextSlotBytes`는 기본8192, 범위128~16384바이트다. 필수 user/image/document·완전한 tool exchange·지침·memory·verification/continuation control과 도구 envelope/output 예약을 보존하고, optional history·repository·approved knowledge보다 먼저 slot을 예약한다. callback은 원본 문맥 해시에 묶인 JSON 객체를 반환한다. 원본 메시지 선택을 그대로 보존하면서 고정 prefix의 assistant DATA entry를 추가한다. unused slot을 해제해도 callback이 확인하지 않은 history를 새로 선택하지 않는다. 전체 entry가 slot에 들어가지 않으면 잘라 넣지 않고 거절한다.

최종 실제 메시지 전체의 해시와 크기를 다시 계산해 ContextRevision·head·native Attempt 요청에 연결한다. 동일 Turn의 일반 retry는 callback을 다시 실행하지 않고 같은 메시지와 revision을 사용한다. 실제 dispatch 직전에는 original context capture, 현재 head, repository/knowledge source, registry 및 저장된 profile 내용 해시를 다시 검사한다. 문맥 생성 중 stop은 표준 `cancelling → cancelled` 경로를 거치고 실제 producer를 만들지 않는다. 이 취소 경계의 저장 실패는 cleanup uncertainty를 보존한다.

`lifecycleContinuation: true`는 별도의 host opt-in이다. 일반 hook은 성공한 stop 경계에서 현재 `verificationSha256`에 묶인 `continue` DATA를 한 번 요청할 수 있다. 실제 host check와 명령 승인을 거친 pass receipt, 현재 plan/registry/source/profile, 완료된 native Turn/최신 Attempt/confirmed cleanup 및 실제 command checkpoint를 읽는다. model 문자열이나 descriptive status만으로 admission하지 않는다. controller·verification ledger revision과 same-Run 소비 문서를 하나의 SQLite CAS로 고정한다.

이어가기는 같은 Run의 원래 turn/input allowance/tool/output/deadline·child 예약 예산을 사용한다. 마지막 합법적 Turn이 이미 예약됐다면 per-Attempt 검사에서 remaining turns0을 허용하며, tool budget0도 추가 tool 실행권을 만들지 않는다. 각 retry 전에 original opaque continuation capture와 실제 ledger/source를 다시 검사한다. capture 복사, 늦은 결과, 불확실한 cleanup, 저장 후 취소는 소비를 되돌리거나 새로운 실행을 승인하지 않는다. 두 번째 `continue`는 typed limit outcome을 기록하고 hook failure policy를 적용한다. port/실제 receipt가 없는 요청 역시 typed outcome과 policy를 따르며 extra Turn을 만들지 않는다.

host DATA를 담은 실제 ContextRevision과 continuation control은 정상 문맥으로 저장된다. 별도 관측/소비 ledger에는 data/message/graph 해시와 owner·원래 remaining budget만 둔다. DB schema를 추가하지 않고 기존 SessionDocument CAS를 사용한다. callback deadline 자체는 외부 효과가 종료됐다는 증거가 아니며, post-effect hook 실패가 이미 실행한 도구를 재실행하지 않는다. 지원 환경과 최종 검사 결과는 [검증 기록](engine-phase-two-lifecycle-transforms-verification.json)에 고정한다. 전체80개 goal과 별도 환경 이월4개는 유지한다.

최종 frozen source 검사: 타입 검사 통과, 전체 engine3,563개 중3,561개 통과·실패0·기존 Windows skip2, 관련 source403개 통과, 실제 scripted coding 평가3개 통과. 신규99개는 typed transform14·actual native continuation11·actual Engine34·runner17·base snapshot1·native SQLite CAS19·ContextPlan3이다. 실제 승인 명령과 provider iterator cleanup을 사용했고 live 계정 호출은 없었다. 정상 Engine close와 동일 DB reopen에서는 ledger revision/owner/hash를 보존하고 추가 provider/명령 호출0을 확인했다. 이 검사에서 강제 종료나 새 archive/import 검증을 수행했다고 주장하지 않는다. MC2-04c/d 완료로 현재20/80·4/20이며 전체 goal은 active다.
