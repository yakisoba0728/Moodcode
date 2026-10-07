# 검증 제어와 저장소 지식 기반 통합

이번 묶음은 MC2-02의 실제 명령 결과·제한 수정·완료 판정을 연결하고, MC2-03의 신뢰·출처·후보 저장 기반을 엔진에 설치한다. 이전 W2의 고정 소스 및 검증 기록은 역사적 근거로 유지한다. 현재 검증 결과와 소스 SHA는 [W3 검증 기록](engine-phase-two-w3-verification.json)에 저장한다.

## 실제 검증 결과와 취소

`verify_changes`는 등록된 검사 ID를 받아 현재 parent profile/discovery catalogue의 원본 `run_command` capability를 준비한다. 명령·cwd·source·내부 fingerprint·실행 상한이 정확한 외부 승인에 포함된다. `captureRegistration/assertRegistrationCurrent`가 원본 producer 등록을 객체 식별자로 고정하므로 같은 이름·schema의 대체 도구가 결과 출처가 될 수 없다.

명령 취소는 실제 프로세스 결과·정리 확인·원본 로그·게시된 checkpoint·사후 source 관측으로만 receipt를 확정한다. 일반 active-Run writer는 cancelling 상태를 계속 거절한다. 별도 consumed settlement는 coordinator가 보유한 원본 ToolContext, 아직 실행 중인 도구 operation과 exact native Run/Turn/Attempt/Part를 확인한다. 동일 SQLite 트랜잭션에서 기존 dispatched receipt 한 건만 settled로 바꿀 수 있다. 계획·receipt 수·다른 결과·실행 identity는 불변이다. 종료 후 콜백과 복제된 context는 거절한다. 증거 없는 exception은 uncertain으로 남기고 재실행하지 않는다.

미지원 실행은 host의 실제 플랫폼 capability 관측을 사용한다. 정확한 승인을 유지하면서 내부 준비·명령 dispatch·checkpoint·로그 생성 없이 unsupported receipt를 기록한다. 이 경로의 fixture는 계약과 effect 0을 검증하며 Windows에서 실제 실행을 검증했다는 뜻은 아니다.

## 같은 Run의 제한 수정과 완료 판정

`VerificationController`는 현재 source·plan/receipt revision·등록 검사·profile·native 종료 경계를 읽고 bounded `RepairStage`와 `CompletionCandidate`를 저장한다. controller CAS와 verification document revision을 하나의 primary transaction에서 검사한다. required check 모두가 현재 source에서 pass이고 명령 및 provider cleanup이 확인돼야 `taskVerified: true`다. 모델 문장, 파일 변경, commit이나 TODO 완료는 검사 증거가 아니다.

부족·실패·stale 검사는 같은 Run에서 최대 두 번의 수정 단계를 발급할 수 있다. 실제 Turn·tool·output·duration·child reservation 및 input allowance를 줄이기만 하며 초기화하지 않는다. 같은 source/check/outcome 반복은 stalled로 끝난다. 다음 모델에 보내는 bounded user-role JSON control DATA는 ContextPlan의 필수 슬롯으로 계산하고 frozen context hash/token/source 검사를 통과한다. 선택적 저장소 evidence가 필수 control을 밀어내면 원래 omission/reprepare 경로를 사용한다. 단계 소비는 논리 경계 CAS이며 권한이나 명령 승인으로 해석하지 않는다.

승인 거부, cancelled, required unsupported/skipped, unknown cleanup 및 사라진 등록 검사는 blocked/incomplete다. outer approval 거부로 receipt가 없어도 실제 denied Tool row를 확인해 재승인을 자동 요청하지 않는다. stop에서는 이미 존재하는 계획을 새로 만들지 않으며 stale 증거를 현재 source와 대조한다. 등록 검사가 첫 계획 전에 사라지면 결과는 check_stale로 기록하고 새로운 repair budget을 만들지 않는다.

`Run.completed`는 실행 loop의 종료 의미를 유지한다. 별도 task completion은 `getVerificationCompletion(sessionId, runId)`에서 조회한다. 완료 후보는 해당 boundary의 source가 고정된 관측이며 archive/import 이후 현재 실행 권한이나 새로운 검사 증거로 재사용하지 않는다. restart·paused import·late receipt는 명령이나 provider dispatch를 자동 재생하지 않는다.

## 저장소 신뢰와 pending 지식

DB10은 workspace-scoped trust revisions/heads, generation plans, candidates, request receipts, import pauses 여섯 테이블을 추가한다. 이전 primary/native/usage/cleanup 기록을 다시 쓰지 않으며 실패한 migration은 전체 rollback한다. recovery/archive의 logical table 목록과 bounded schema 검사도 DB10을 포함한다.

실제 엔진 host API는 `previewWorkspaceTrust/setWorkspaceTrust`, `captureWorkspaceKnowledgeSources`, `captureWorkspaceKnowledgeTarget`, `prepareWorkspaceKnowledgeGeneration`, `releaseWorkspaceKnowledgeSources`다. 신뢰 승인은 이 엔진의 원본 preview 및 실제 canonical root/device/inode·DB/artifact identity·지침 파일 pins에 결속한다. CAS·dedupe·철회·expiry를 저장한다. 파일 source와 완료된 native 대화의 명시적 선택만 bounded canonical text로 투영하고 currentness를 다시 검사한다. opaque replay와 media/provider metadata는 source body에 포함하지 않는다.

생성 계획은 pending 데이터다. host source/target capture를 실제 엔진과 SQLite에서 검증하지만 모델을 호출하거나 가짜 Session/Run을 만들지 않는다. 기존 파일 target은 실제 revision port가 없으면 unavailable, workspace-document target은 unsupported다. 존재하지 않는 새 파일은 실제 absent preimage를 확인해 revision 0으로 고정한다. 후보는 원래 generation output/hash·tool count 0·confirmed cleanup·nullable usage를 native host owner가 제공할 때만 추가할 수 있다. 그 실행 owner와 추출 공급자는 아직 구현하지 않아 production candidate append는 차단된다.

archive는 새 기록을 검증·해시하고 import는 primary/child workspace 지식을 paused로 보존한다. 과거 trust와 계획은 원래 hash로 조회할 수 있지만 새로운 DB/artifact의 권한으로 재결속하지 않는다. 실제 extraction/inbox, 승인 후 publish/revoke, 기존 target revision 저장 및 활성 ContextPlan projection은 MC2-03의 다음 작업이다.

## 검증 범위

독립 프로세스 명령, native SQLite, real filesystem 및 실제 Engine의 모델 경계를 사용했다. 주요 흐름은 missing check→같은 Run의 check→verified, 실제 실패→명령으로 source 수정→재검사→verified, 같은 결과 반복→stalled, 예산 소진, 실제 승인 거부, source/registry 변경, 같은 Turn retry/steer, 취소 중 단일 receipt 확정, DB9→DB10 rollback, pending plan 및 paused archive import다. 새 모듈 fixture와 전체 headless 회귀 결과는 검증 JSON에 각각 기록한다.

MC2-03a는 기반 구현 중이다. 실제 tools-free host generation owner/output/usage가 없어 production candidate의 생성까지 완료로 표시하지 않는다. 기존 외부 환경 이월 E5-13/E5-08/E6-07/E6-08과 전체 80개 goal은 그대로 유지한다.
