# 기본 도구 목록과 문맥 예산의 일치

G1-29는 default eager 모드에도 같은 도구 catalogue의 reservation·문맥 계획·provider schemas·handler resolve를 적용한다. [기존 도구 검색](engine-tool-discovery.md)의 opt-in add/replace 계약과 [MCP 승인·종료](engine-mcp-execution.md)는 유지한다. 구현 전 실제 대조군과 범위는 [조사](research/2026-10-07-eager-catalogue-reservation.md), 최종 source·검사는 [최신 검증](engine-goal-verification.md)을 따른다.

## 계획과 전송

현재 scope/profile/Run allowlist/mode/policy를 적용한 opaque ToolCatalogue를 캡처한다. Eager catalogue의 exact signature·registry revision·policy version이 같으면 같은 handle을 재사용한다. `catalogue()`가 매번 새 객체를 반환하는 특성을 source 변경으로 오인해 재계획을 반복하지 않는다.

예약은 실제 광고하는 tools array로 `UTF8 JSON({ messages: [], tools }) bytes - 2`를 계산한다. 같은 예약값을 실제 ContextService/ContextPlan에 전달한다. Async build가 끝나면 catalogue의 현재성을 다시 확인하고 registry/policy가 바뀌었으면 최신 예약으로 최대16회 다시 계획한다. Normal turn과 steer 경계에도 이 과정을 적용하고 재계획 중 들어온 steer를 dispatch cutoff 전에 다시 확인한다. Dispatch 재계획과 steer 재계획도 각각16회로 제한한다.

Known model window/output reserve는 ContextPlan의 기존 보수적 추정으로 검사한다. Unknown window는 unknown으로 유지한다. Final configured byte cap도 계속 적용한다. 실제 tokenizer의 정확한 토큰 수나 원격 모델의 수락을 보장하지 않는다.

Eager와 discovery 모두 `context.prepared`에 reservedToolBytes, 실제 tools array의 SHA256, advertisedToolNames를 기록한다. Runtime capture가 있을 때 registryRevision/policyVersion도 기록한다. SHA는 canonical registration SHA나 raw HTTP SHA와 다르다. Full schemas를 대화 기억으로 저장하지 않으며 DB9/metrics6은 유지한다.

## 시도·권한 경계

동일 logical Turn의 HTTP retry는 원래 schemas/messages를 유지하고 각 Attempt의 ID/cleanup receipt를 별도로 만든다. 모델 어댑터에는 각 Attempt마다 전체 요청의 detached data 사본을 전달해 어댑터의 nested mutation이 다음 retry나 원래 request digest를 바꾸지 못하게 한다. 다음 logical turn의 host schemas와 handler도 별개로 보존한다.

Overflow recovery는 원래 schema/handler capture와 reservation을 고정한다. Recovery의 await 동안 source가 바뀌면 eager는 TOOL_CATALOGUE_STALE, discovery는 TOOL_DISCOVERY_STALE로 다음 Attempt 전에 중단한다. 기존 provider cleanup·summary ownership·source/CAS 규칙을 유지한다.

`ScopedToolRuntime.assertCatalogueCurrent(catalogue)`는 같은 runtime이 만든 original capture의 WeakMap membership·exact signature·revision/policy를 검사한다. 빈 catalogue도 검사할 수 있다. Foreign/copied/tampered handle을 현재 catalogue로 인증하지 않는다. 기존 resolve/prepare/execute는 같은 guard와 handler token·grant·취소 검사를 유지한다. 이 API는 tool effect 권한을 부여하지 않는다.

Runtime이 없는 trusted Coordinator의 static tools·Run allowlist·original prepared handles도 유지한다. Static 포트에 동적 registry를 추가하지 않는다. 빈 static/runtime catalogue는 예약24B로 처리하고 재계획 churn을 만들지 않는다.

## 검증 범위

Actual default core21/ContextService의 byte cap·known window·async registry/policy·steer·정상 turn 성장·16회 변경·취소·HTTP retry·overflow stale를 검증한다. 별도 actual temporary SQLite/Coordinator는 runtime 없는 static read/state·allowlist·empty catalogue·adapter mutation·exact cleanup request SHA를 검증한다. Synthetic provider와 무효과 fixture이며 외부 계정·프로젝트 recovery ACK·GUI를 사용하지 않는다. 실제 Codex 검사는 같은 최종 source의 도구0개 default eager child text와 저장/archive/import 회귀다.
