# 메인 엔진 2차 W1 구현

2026-10-07. [goal](engine-phase-two-goal.md)과 [작업 상태](engine-phase-two-progress.json)를 따른다. MC2-01/04/11/12의 첫 통합 범위이며 전체 20개 범위의 완료를 뜻하지 않는다. upstream 코드·prompt·fixture를 복사하지 않고 기존 Moodcode 계약 위에 구현했다.

## 저장소 문맥

`RepositoryContextService`와 `LspManager.querySymbols/queryDefinitions/queryReferences`를 엔진에 연결했다. host가 서버·언어·revision을 등록하며 모델은 실행 파일이나 서버를 선택하지 못한다. host API `getRepositoryContext`는 항상 현재 파일을 다시 관측한다. `repositoryContextTools: true`를 선택하면 read 도구 `repository_context`가 captured profile/eager/discovery 경로에 들어간다. 기본 core21 노출은 유지한다.

현재 기능은 명시적으로 선택한 파일과 LSP 관계의 구조 관측이다. snapshot에는 source hash·document version·Git head/branch·host parser routing revision·실효 ignore 결과·generation과 omission을 고정한다. 서로 다른 동시 관측이 winning generation을 덮어쓰지 못한다. 재시작 뒤 cache를 현재 source 증거로 재사용하지 않는다. 파일 선택 최대8개, source 최대4MiB, navigation 최대64 locations/16 source files/16KiB, 전체 query 15초를 제한한다. symlink·workspace 밖 URI·Git/dependency metadata·무시된 파일은 읽기 권한이 되지 않는다. UTF-16 selection/enclosing/origin 범위와 현재 hash를 검사한다.

실제 stdio LSP protocol과 모델 도구→native Part/history→ContextPlan 경로를 검증했다. stdio 서버는 독자 fixture이며 실제 언어 서버의 semantic 품질 검증을 대신하지 않는다. 자동 관련 파일 선택·snippet 공급자·전체 graph/FTS/vector/rerank와 semantic LSP의 큰 corpus 성능은 남았다. 도구 출력과 다음 대화는 기존 출력·문맥 예산과 complete exchange를 따른다.

## 생명주기

[생명주기 설명](engine-lifecycle-hooks.md)의 순수 host callback을 Run별 capture로 연결했다. stage는 before-model/after-model/tool-prepared/tool-settled/before-stop이며 결과는 observe/deny/stop이다. 원문 request/input/output·credential·opaque replay를 전달하지 않는다. 기본 metadata/result4KiB·callback/dispatch1초를 제한하며 registry 변경, 늦은 결과와 취소를 거절한다.

모델 훅은 native provider dispatch intent 전에 실행한다. 준비된 도구는 승인 전과 실행 직전 동일 opaque input·fingerprint·정책을 확인한다. stop은 기존 cancelling→cancelled 경로를 따른다. 실제 효과 뒤 훅 실패는 완료 기록과 checkpoint를 보존하며 cleanup uncertainty를 덮지 않는다. 동적 host registry를 owned child에도 공유하고 capture/release는 각각의 Run에 묶는다. typed outcome은 Run/Turn/Attempt 소속을 검사한 동일 트랜잭션으로 native/legacy journal에 남는다.

context/input rewrite, 검증·잔여 예산을 요구하는 continuation과 외부 process/HTTP hook은 남았다. callback deadline은 외부 효과 정리 증거가 아니다.

## 역할 권한과 사전 검사

host opt-in `roleResourcePolicy/resolveRoleResources/commandPreflight`를 ScopedToolRuntime의 prepare·dispatch에 연결했다. 역할은 persisted agent profile revision으로 고정하며 eager/discovery에 동일하게 적용한다. canonical file identity와 정확한 host MCP server/connection/catalogue/resource identity를 검사한다. 누락된 역할·resource·unknown effect는 ask, deny 우선이다. role/preflight allow로 원래 exact 승인이나 기본 ask를 낮추지 않는다.

사전 검사는 host analyzer ID/revision/source digest와 exact producer command/canonical cwd/prepared fingerprint/host source revision을 고정한다. 실패·timeout은 ask, 취소는 executable prepared request를 만들지 않으며 승인 이후 변경은 실행을 거절한다. 검사는 OS sandbox 증거가 아니다. 실제 approved command 실행과 승인 중 source 변경 시 효과0을 검증한다.

승인되지 않는 allow/deny까지 런타임이 직접 발급한 immutable receipt를 두 journal에 저장한다. `getPolicyDecisionReceipts`는 최대100 native events와 출력 byte cap의 관측 페이지를 반환한다. oversized receipt는 omission과 전진 cursor로 표시한다. 짧은 페이지를 세션 전체 끝으로 단정하지 않는다. 반환된 영수증 사본과 임의 error details는 실행·승인 권한이 아니다. 실제 외부 MCP 연결의 교체·resource policy 운용 검증은 추가 lane으로 남긴다.

## 진단과 다음 단계

[진단 설명](engine-phase-two-diagnostics.md)의 bounded native trajectory·coding Run/Attempt manifest·typed 오류 분류·advisory stall을 host API에 연결했다. unknown usage와 partial output을 보존하고, billed total·검증 통과·작업 성공을 추측하지 않는다. 실제 과거 source/effect epoch writer·tool registration inspector·tools-free distillation은 남았다.

W2 verification 모듈은 별도 병렬 작업이다. `putActiveRunDocument`로 active Run/cancelling 거절·문서 CAS를 동일 primary transaction에서 확인하는 저장 경계를 추가했다. plan/check 실행·receipt·repair·completion gate의 실제 소비가 끝나기 전 W2 완료로 세지 않는다. GUI와 live provider 요청은 이번 검증에 포함하지 않았다.

최신 실행 명령·결과·source hashes는 [W1 검증 기록](engine-phase-two-w1-verification.json)에 남긴다. 기존 비교의 고정 SHA와 이월 환경4개를 덮어쓰지 않는다.
