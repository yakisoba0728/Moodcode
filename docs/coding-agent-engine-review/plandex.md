# Plandex 엔진 정적 분석

분석일: 2026-10-07. 원본: [https://github.com/plandex-ai/plandex](https://github.com/plandex-ai/plandex), full HEAD `e2d772072efadbe41d2946d97d79be55532dbab5`. 로컬 원본: `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/plandex`. Moodcode 문서 기준 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 기준 `464812f7d1af24466f57070663131f5979aeca51`. [분석 기준](./analysis-protocol.md)과 [구현 상태](../moodcode/implementation-status.md)를 적용했다. JSON은 [plandex.evidence.json](./plandex.evidence.json)에 기록했다.

Plandex에서 가장 유용한 참고 동작은 **작업별 파일 문맥 선택, 여러 turn의 미적용 파일 변경 축적, 제한된 편집 검증·복구, 단계별 모델 선택**이다. 서버의 plan 저장소와 CLI의 사용자 프로젝트가 분리되어 있다. README의 sandbox는 우선 누적 변경을 검토하는 저장 계층이며, 실제 명령을 제한된 OS 환경에서 실행한다는 뜻으로 확대하면 안 된다.

## 저장소·언어·라이선스·유지보수 경계

- `app/cli`, `app/server`, `app/shared`는 각각 별도 Go module이며 모두 Go 1.23.3을 선언한다. CLI/server가 shared를 상대 경로로 연결한다. [CLI module](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/go.mod#L1-L4), [server module](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/go.mod#L1-L13), [shared module](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/shared/go.mod#L1-L4). tree-sitter map CLI도 별도 module이다. [app/server/syntax/file_map/cli/go.mod:1](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/syntax/file_map/cli/go.mod#L1-L4)
- CLI 진입점 `main → cmd.Execute`와 Cobra `doTell → plan_exec.TellPlan`이 사용자 입력을 받는다. 서버 진입점은 Gorilla mux routes, LiteLLM 준비, DB 초기화, HTTP server 시작이다. [app/cli/main.go:63](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/main.go#L63-L80), [app/cli/cmd/tell.go:60](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/cmd/tell.go#L60-L80), [app/server/main.go:14](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/main.go#L14-L36)
- root `LICENSE`는 MIT이고 저작권 표기는 2025 PlandexAI Inc.다. 고정 HEAD의 tracked 파일 목록에서 하위 `LICENSE/LICENCE/COPYING/NOTICE` 파일은 추가로 찾지 못했다. 이는 Go module·tree-sitter grammar·Python 패키지·Docker 이미지의 전체 라이선스 audit가 아니다. [root MIT LICENSE](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/LICENSE#L1-L21)
- **유지보수 관측:** HEAD의 author/commit 시간은 `2025-10-03T14:49:54-07:00`, commit 제목은 cloud 종료 안내 링크 추가다. 해당 README는 2025-10-03부터 Plandex Cloud를 정리하고 신규 가입을 받지 않는다고 고지하며 local/self-hosted 경로를 안내한다. 2026년 현재 서비스·이슈·릴리스 상태는 조사하지 않았다. [고정 README의 Cloud 고지](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/README.md#L152-L158)
- PostgreSQL은 metadata/locks를, 서버 파일 저장소와 별도 plan Git repo는 context·conversation·results/history를 담당한다. local Docker compose도 PostgreSQL과 서버 volume을 구분한다. [PostgreSQL Connect](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/db.go#L24-L50), [별도 plan Git 초기화](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/git.go#L37-L57), [local 서비스 구성](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/docker-compose.yml#L1-L30)
- 모델 공급자·OpenRouter·Claude subscription·Ollama/custom 등은 외부 서비스 경계다. `newClient`의 auth variable/BaseURL 선택(R20)과 서버가 띄우는 Python LiteLLM proxy가 존재한다. [provider 종류](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/shared/ai_models_providers.go#L38-L55), [Python proxy 실행 설정](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/litellm.go#L106-L117). root MIT가 공급자 이용 조건이나 cloud/private hook 구현의 사용 권한을 보장하지 않는다.

## 실제 실행 경로

1. CLI `TellPlan`은 서버의 현재 context를 조회하고 로컬 파일의 outdated 상태를 확인한다. 갱신되지 않은 context이면 prompt 전송을 중단한다. 요청에는 project paths, build mode, auto-continue, auto/smart context, exec enabled가 포함된다(R01). [context preflight](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/plan_exec/tell.go#L74-L106)
2. HTTP `TellPlanHandler → modelPlan.Tell → activatePlan → execTellPlan`이다. handler는 plan ownership/update permission을 확인하고, 활성 stream을 등록한 뒤 비동기로 실행한다. 같은 plan/branch에 이미 active stream이 있으면 시작을 거절한다. [Tell handler 호출](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/handlers/plans_exec.go#L98-L105), [plan update RBAC](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/handlers/plans_exec.go#L619-L631), [Tell 활성화·비동기 실행](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_exec.go#L42-L67), [active stream 검사](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/activate.go#L32-L66)
3. `loadTellPlan → resolveCurrentStage → formatModelContext → addConversationMessages → doTellRequest`로 모델 입력을 만든다. 단계는 context 선별/계획/구현이며 architect/planner/coder 선택이 실제 분기다(R02). `doTellRequest → CreateChatCompletionStream → listenStream`으로 응답을 받는다(R03).
4. 주된 작성 경로는 모델의 **텍스트 스트림을 전용 reply parser로 읽어 operation을 만드는 방식**이다. `processChunk → handleNewOperations → queueBuilds → queueBuild → execPlanBuild`가 파일·move·remove·reset 작업을 연결한다(R04, R19). [스트림 파싱·context에 없는 파일 처리](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_processor.go#L78-L120). 이 주 경로를 일반적인 native tool-call/MCP loop와 동일시하지 않는다. 내부 상태 판별용 `ModelRequest`는 별도 tools 인자를 지원한다. [내부 요청 tools 필드](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/model_request.go#L26-L36)
5. 파일별 build는 원본 또는 현재 pending 상태를 기반으로 편집을 만든다. 결과는 서버에 저장되고, 답변·subtask 상태를 기록한 뒤 context-load handshake 또는 다음 iteration으로 이어진다(R05, R10). 답변이 끝나도 build가 남으면 build 종료를 기다린다. [pending pre-build 우선 선택](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_exec.go#L412-L429), [reply/build 종료 조정](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_finish.go#L225-L245)
6. 계획 단계의 auto-continue는 요청 플래그와 남은 subtask를, 구현 단계는 남은 subtask와 iteration 상한을 따른다. 구현 단계 상한은 200이다. 이 조건을 모든 단계에 공통인 전역 예산으로 읽지 않는다. [willContinuePlan 종료 분기](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_status.go#L177-L219), [iteration 상수](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_finish.go#L18-L18)
7. 실제 사용자 파일 변경은 `apply` 또는 auto-apply가 호출하는 CLI `MustApplyPlanAttempt → ApplyFiles`에서 일어난다(R11). 명령은 별도 `handleApplyScript → execApplyScript`로 실행한다(R12). 성공하면 서버 `apiApplyPlan`에 적용 완료를 반영하고 선택적으로 로컬 Git commit을 만든다. [적용 성공 처리](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply.go#L210-L248)

## 문맥·기억·검색과 대형 프로젝트 map

**구현 확인:** `formatModelContext`는 현재 subtask의 `UsesFiles`에 따라 일반 파일 context를 제외한다(R06). map은 계획 단계에서 쓰고 작성 단계에서는 필요한 파일 본문을 선택하는 구조다. map의 `Definition`은 signature/comment/line/children을 담고(R08), `MapFile`은 언어 parser로 tree-sitter AST를 만든다. 지원 밖 파일에는 placeholder 또는 빈 definitions가 나올 수 있다. [map 지원·fallback](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/syntax/file_map/map.go#L39-L73), [tree-sitter parse](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/syntax/file_map/map.go#L75-L103)

**구현 확인:** CLI가 실제 파일 본문을 읽어 서버로 올린다. 서버가 요청한 auto-load paths는 스트림 메시지로 CLI에 전달되며 서버가 응답 채널을 기다린다(R05). CLI `AutoLoadContextFiles`는 파일수·개별/총 크기를 확인하고 순서를 보존한 request를 보내며 skip 결과를 알린다. [bounded 로컬 읽기](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/context_auto_load.go#L37-L83), [ordered auto-load 응답](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/context_auto_load.go#L125-L148). 이는 서버가 사용자 디스크를 직접 탐색하는 경로와 구분된다.

**구현 확인:** map 업데이트는 path별 본문·입력 SHA·토큰·크기를 저장한다(R09). 일반 context는 SHA-256을 갱신하고, `StoreContext`가 body/meta/map-parts 파일로 저장한다. [일반 context hash](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/context_helpers_update.go#L328-L337), [context body/meta 저장](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/context_helpers_store.go#L69-L86). 프로젝트 map cache는 path 기반 cache key와 map 입력 metadata를 보관한다. [project map cache metadata](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/context_helpers_store.go#L99-L117). source hash와 context 상태 추적은 확인했지만, 실행 없이 cache 재사용의 전체 일관성을 검증했다고 주장하지 않는다.

**구현 확인:** 대화 토큰이 설정 상한을 넘으면 기존 `ConvoSummary`의 cutoff/토큰을 비교해 들어맞는 summary를 선택한다. 줄이지 못하면 오류로 끝난다. 답변 저장 이후에는 summary를 background 생성한다. [summary 선택 시작](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_summary.go#L60-L75), [summary 예산 검사](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_summary.go#L109-L135), [background summary](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_finish.go#L114-L141). 이 경로는 symbol map과 대화 압축이며, 확인한 호출에서 vector retrieval·영구 의미 기억의 품질을 입증하지는 않는다.

**README 주장:** 직접 2M context, 20M 이상 directory indexing, 30개 이상 언어 map/검증, 다양한 공급자 caching을 소개한다. 구현에서 role별 입력 선택·maps·cache-control 경로는 확인했지만 숫자·성능·모든 공급자의 cache 동작은 검증하지 않았다. [대형 문맥·map·cache 주장](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/README.md#L81-L101)

## 변경 축적·검토 sandbox와 프로세스 경계

**구현 확인:** `GetPlanResult`는 pending 결과와 replacements를 경로별로 모으고(R10), 다음 모델 입력은 아직 적용하지 않은 파일 내용을 원래 loaded context보다 우선한다(R07). 따라서 여러 파일에 걸친 변경을 사용자 프로젝트에 쓰기 전에 축적하고 그 가상 최신 상태를 모델이 이어서 볼 수 있다. 파일별 build 완료는 `StorePlanResult`로 저장되며 build 종료에 plan repo Git commit을 만든다. [결과 저장](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_finish.go#L195-L215), [plan 결과 history commit](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_finish.go#L128-L134)

**구현 확인:** CLI는 파일 적용 확인을 받고 잠정 적용한다(R11). `_apply.sh` 내용은 출력하고 `AutoExec`가 아니면 별도 확인한다. [명령 표시·확인](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply.go#L267-L298). 실패한 명령은 rollback 선택 또는 debug 후 재적용으로 연결된다. 여러 turn의 pending diff 검토와 로컬 임시 rollback은 구분해야 한다.

**구현 확인:** CLI shell은 사용자 프로젝트 root, 현재 환경 변수, 현재 stdin에서 실행된다(R12). POSIX process group을 새로 만들고 신호를 그룹에 전달한다. Linux의 cgroup scope는 systemd user manager 연결·등록 실패 시 no-op fallback이며, Linux 밖 구현도 no-op이다. [process group](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply_proc.go#L8-L15), [cgroup fallback](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply_cgroup_linux.go#L20-L30), [scope 등록](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply_cgroup_linux.go#L37-L57), [비 Linux cgroup 경계](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply_cgroup_other.go#L8-L10)

**분석자 해석:** 이 프로세스 설정은 주로 자식 프로세스 종료 범위를 관리한다. 확인한 command launch가 별도의 container/filesystem/network 권한 격리를 만들지는 않는다. 서버 Docker hosting을 CLI 명령 sandbox로 설명하면 사용자에게 잘못된 보장을 주게 된다. 저장소 밖 부작용까지 rollback한다고 추정하지 않는다.

## 편집 검증·명령 실패 복구

**구현 확인:** 파일 편집은 `syntax.ApplyChanges`의 직접 적용 결과를 먼저 문법 검사한다. syntax 오류 또는 `NeedsVerifyReasons`가 있으면 `buildRace`로 넘어간다. [직접 편집·문법 판별](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_structured_edits.go#L104-L130), [검증 fallback 전환](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_structured_edits.go#L138-L164). race는 validation/fast apply/whole-file fallback 결과를 조정하고 첫 성공을 선택한다(R14). [whole-file fallback](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_race.go#L97-L108), [fast apply 문법·모델 검증](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_race.go#L152-L183)

**구현 확인:** `buildValidateLoop` 기본 복구 시도는 3회이며, 3번째부터 등록된 StrongModel을 쓸 수 있다. 각 시도 후 모델의 valid와 문법 오류를 같이 확인한다(R13). [복구 시도 상수](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_validate_and_fix.go#L22-L22), [bounded loop·취소](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_validate_and_fix.go#L60-L72). parser가 없거나 원래 syntax-invalid/timeout 상태일 때는 `validateSyntax`가 오류 목록을 반환하지 않는 경로도 있다. [검증 생략·timeout 경계](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_structured_edits.go#L223-L237). 그러므로 valid 결과를 모든 언어의 정적 검증이나 의미적 정확성 증명으로 표현하지 않는다.

**구현 확인:** 명령 실패 callback은 `AutoDebug` 시도 한도를 확인한다. 이어갈 때 잠정 파일을 rollback하고 exit/output을 모델 입력으로 전달하며 `TellPlan → MustApplyPlanAttempt(attempt+1)`로 재시도한다(R15). [auto-debug 상한](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/plan_exec/apply_exec.go#L32-L41), [rollback·실패 입력](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/plan_exec/apply_exec.go#L118-L126). 테스트 명령도 이 일반 shell/debug 경로를 사용할 수 있지만, 실제 테스트 통과·repair 성공률은 이번 분석으로 확인하지 않았다.

## 승인·취소·저장·branch·동시성·확장

- **승인:** 서버 plan ownership/RBAC와 CLI의 파일 적용·명령 실행 확인은 별도 경계다. `AutoConfirm/AutoExec/AutoApply`는 사용자 설정에 따라 확인을 자동화한다. 이 경로가 Moodcode의 durable fingerprint approval과 같은 계약이라고 가정하지 않는다(R01, R11, R12 및 위 command 확인 소스).
- **취소:** `Stop`은 summary/plan context를 취소한다(R16). stop handler는 write repo operation 안에서 partial reply를 저장한 뒤 Stop을 호출한다. [partial reply·Stop 연결](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/handlers/plans_exec.go#L299-L324). 모델 streaming 중에도 active context 취소를 감시한다. [stream 취소 관측](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_main.go#L86-L100). 재시작·분산 host 장애 후 정확한 정리/재실행 계약은 실행으로 검증하지 않았다.
- **저장/history/branch:** plan 전용 Git repo에 context·conversation·results 변경을 기록하고 history/rewind/checkout API를 지원한다. [plan Git commit](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/git.go#L67-L85), [plan rewind](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/git.go#L95-L108), [plan history](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/git.go#L197-L208). `CreateBranch`는 그 plan repo에 Git branch를 만든다(R17). 로컬 프로젝트 branch/worktree를 자동으로 동일하게 분기한다고 해석하지 않는다.
- **동시성:** 같은 파일의 build는 경로별 queue를 사용하고 다른 파일 build는 goroutine으로 시작할 수 있다(R19). 뒤따르는 같은 파일 build는 이전 build 처리가 끝난 후 실행한다. [다음 파일 build](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_finish.go#L323-L337). 저장소 read/write lock은 plan repo checkout 충돌을 피하도록 다른 branch read도 충돌시킨다(R18). 여러 branch를 동시에 독립 worktree에서 실행하는 구조와 다르다. map 처리도 bounded job queue와 CPU 동시성 제한이 있다. [map queue 상한](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/handlers/file_maps_queue.go#L18-L28), [CPU worker 상한](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/handlers/file_maps_queue.go#L32-L46)
- **모델 역할:** architect/planner/coder뿐 아니라 summary/builder/whole-file-builder/name/commit-message/exec-status 역할이 선언된다. [model roles](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/shared/ai_models_roles.go#L5-L17). 실제 단계 분기(R02)와 validation escalation(R13), provider별 client(R20), provider/model fallback 선택이 연결된다. [모델·공급자 fallback](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/client.go#L154-L186). 역할별 모델 호출은 독립적인 하위 agent 실행·권한·수명 관리의 증거가 아니다.
- **확장:** named `Hook` 등록/실행 경계가 있고 미등록 hook은 빈 결과를 돌려준다. [server hook API](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/hooks/hooks.go#L170-L183). cloud/private integration과 fast-apply hook의 실제 외부 구현은 확인 범위 밖이다. 확인한 주요 엔진 파일에서는 일반 MCP catalog·독립 sub-agent lifecycle·skill registry를 찾지 못했으며, 이것을 전체 제품의 부재 증명으로 쓰지 않는다.

## Moodcode와 비교한 추가 계약

Moodcode의 기존 기능은 [implementation-status](../moodcode/implementation-status.md)의 완료 범위와 실제 소스를 함께 비교했다. 이번 upstream 분석에서 Moodcode 테스트를 다시 돌리지는 않았다.

| 비교 범위 | Moodcode에서 실제로 확인한 구현 | 추가 후보의 차이 |
|---|---|---|
| bounded context·기억 | [planContext](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/plan.ts:29), [EngineContextService.build](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/service.ts:78)는 model identity·context budget·지침/summary/active-prefix를 결합한다. | 프로젝트 symbol map과 task별 referencedPaths의 선택/버전 계약을 추가한다. |
| task·문서 버전 | [SessionTaskService](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/session-state/index.ts:10)는 id/title/status를 CAS 저장하고, [recordCheckpoint](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/workspace/changes.ts:200)는 파일 문서 변경 관측을 묶는다. | 이미 task가 있으므로 새 todo 기능으로 계산하지 않는다. task→file context 의존성과 parser/source hash 연결이 후보다. |
| 승인·편집·review | [sameRequest/ApprovalManager](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/permission/index.ts:44), [apply](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/patch/index.ts:193), [getReviewDiff 누적 chain](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/index.ts:138), [preview/restore](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/index.ts:451)는 정확한 승인·현재 hash·적용된 변경 diff/복원을 지원한다. | 승인 전 여러 turn의 변경을 별도 ProposalSet에 축적하고 모델 입력에도 project하는 overlay가 후보다. |
| worktree·child | [detached worktree 생성](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/worktrees/index.ts:418)와 기존 child/merge 계약이 있다. | 단순 sandbox/worktree 생성은 신규 후보가 아니다. 제안 revision과 accept/reject의 사용자 검토 계약을 재사용 계층 위에 더한다. |
| formatter·LSP·명령 | [host FormatterRegistry](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/formatters/index.ts:14), [bounded propose](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/formatters/index.ts:38), 기존 command·LSP 경로가 있다. | validator 결과 종류·repair owner·시도 한도를 명시한 검증 상태 기계가 후보다. |
| 모델·시도·profile | [immutable AgentProfiles.apply](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/agents/index.ts:32), [TurnExecutor.stream](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/turn-executor.ts:36)은 model/config revision과 durable attempt를 보존한다. | 같은 작업의 단계별 role routing과 escalation 이유·새 context/예산 산정 계약이 후보다. |
| 안전 정책 | [ToolPolicy.evaluate](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/permission/policy.ts:34)는 deny 우선·Plan/Build·prepared approval을 유지한다. | Plandex autonomy flag를 그대로 가져오지 않고 모든 새 계약을 기존 정책 안에 둔다. |

우선순위 P1은 다음 대형 과업 개선 후보, P2는 그 뒤이며 비용 M/L은 독립 구현의 상대 난이도다. 아래는 동작 명세이며 구현 완료나 성능 개선 실측을 뜻하지 않는다.

### plandex-task-context-map — 버전 고정 프로젝트 map과 작업별 파일 문맥 선택

우선순위 **P1**, 비용 **L**. 기존 상태: 부분 구현: bounded ContextPlan·지침 baseline·문서 버전·CAS task는 존재한다. task별 파일 의존성과 syntax map projection 계약은 확인한 경로에 없다. 근거: R06, R08, R09, R05.

독립 구현 계약:

- 호스트가 workspace/path/content SHA/parser revision을 고정한 읽기 전용 symbol-map artifact를 만든다. 크기·시간·파일수 한도를 적용하고 unsupported/timeout/omitted를 명시한다.
- 기존 task CAS 문서와 별도 버전의 bounded referencedPaths를 연결하고 선택 이유·source hash·context bytes를 ContextPlan에 기록한다. 경로 선택은 파일 읽기·쓰기 권한을 부여하지 않는다.
- 변경 관측 후 stale map을 재생성하며 task별 필요한 파일과 필수 최근 exchange를 보존한다. 순서와 omission 정책을 결정적으로 유지한다.

검증 조건:

- 언어 지원 밖·손상 문법·취소·초대형 파일에서 bounded partial/unknown 결과를 유지한다.
- 동일 입력 map과 context digest가 동일하고 외부 편집·rename·delete 후 이전 SHA를 재사용하지 않는다.
- 일반 task title만 가진 기존 기록을 계속 읽고, task의 referencedPaths가 Plan/Build·deny 정책을 확장하지 않는다.

관련 Moodcode 경로: [packages/engine/src/context/plan.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/plan.ts:1), [packages/engine/src/context/service.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/service.ts:1), [packages/engine/src/context/sources.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/sources.ts:1), [packages/engine/src/session-state/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/session-state/index.ts:1), [packages/engine/src/workspace/changes.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/workspace/changes.ts:1).

### plandex-review-proposal-overlay — 미적용 변경 집합과 모델 문맥의 proposal overlay

우선순위 **P1**, 비용 **L**. 기존 상태: 부분 구현: fingerprint approval·checkpoint 누적 diff·restore·격리 worktree/child merge는 이미 존재한다. 여러 turn의 미적용 제안에 대한 독립 overlay/revision 계약은 별도 후보다. 근거: R07, R10, R11, R17, R19.

독립 구현 계약:

- ProposalSet을 session/workspace/base hash 집합/revision에 묶고 create/update/delete/rename 제안을 실제 사용자 파일에 쓰기 전에 축적한다.
- 다음 모델 경계에서 승인 전 overlay를 명시적으로 project하고 source hash·proposal revision·원본과 제안의 구분을 기록한다. 동일 파일 제안은 revision 순서로 합성한다.
- review accept/reject는 정확한 선택 revision과 현재 base hash를 재검사한다. 변경된 제안은 기존 승인을 재사용하지 않으며 부분 적용·취소·불확실 효과는 기존 journal 계약으로 남긴다. 명령은 별도 승인과 실행 공간을 요구한다.

검증 조건:

- 두 파일·여러 turn 제안 후 accept 전 사용자 파일의 bytes가 바뀌지 않는다.
- 중간 제안 reject·rename/delete·외부 편집·중복 요청·재시작 후 동일 projection 또는 명시적 conflict가 나온다.
- 선택한 제안만 적용되고 변경된 preview·base SHA에서 stale approval이 거절된다.

관련 Moodcode 경로: [packages/engine/src/tools/patch/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/patch/index.ts:1), [packages/engine/src/review/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/index.ts:1), [packages/engine/src/review/audit.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/audit.ts:1), [packages/engine/src/worktrees/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/worktrees/index.ts:1), [packages/engine/src/permission/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/permission/index.ts:1), [packages/engine/src/context/service.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/service.ts:1).

### plandex-edit-validation-ladder — 관측 결과를 남기는 제한된 편집 검증·복구 단계

우선순위 **P1**, 비용 **M**. 기존 상태: 부분 구현: 정확한 hash 편집·formatter/LSP·명령 도구·provider retry는 있다. 제안의 문법/명령 검증을 다음 repair 시도와 묶는 bounded 상태 기계는 별도 후보다. 근거: R13, R14, R15, R12.

독립 구현 계약:

- 호스트가 validator identity/revision을 등록하고 ProposalSet revision에 대해 syntax 또는 승인된 check 명령을 수행한다. supported/passed/failed/timeout/skipped/unknown을 구분한다.
- repair는 실패 artifact와 정확한 제안 revision을 입력으로 사용한다. 시도 수·누적 시간·출력·모델 예산을 제한하고 변화가 없는 제안을 반복하지 않는다.
- 검증 전 취소·validator 미지원·모델 판단만 있는 상태는 성공 증명으로 승격하지 않는다. 재작성 결과는 새 SHA·preview·승인이 필요하다.

검증 조건:

- 원래 문법 오류와 새 오류를 구분하며 unsupported/timeout이 passed로 기록되지 않는다.
- 실패→repair→새 검증의 owner/revision 연결을 확인하고 최대 시도·취소·같은 실패 반복에서 종료한다.
- check 명령·새 편집이 기존 승인·deny·child 예산을 지키며 실패 후 사용자 파일 복원은 현재 hash 충돌 검사를 유지한다.

관련 Moodcode 경로: [packages/engine/src/tools/patch/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/patch/index.ts:1), [packages/engine/src/formatters/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/formatters/index.ts:1), [packages/engine/src/lsp/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/lsp/index.ts:1), [packages/engine/src/runner/turn-executor.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/turn-executor.ts:1), [packages/engine/src/tools/command/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/command/index.ts:1), [packages/engine/src/permission/policy.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/permission/policy.ts:1).

### plandex-model-role-routing — 단계별 모델 역할과 증거 기반 escalation 기록

우선순위 **P2**, 비용 **M**. 기존 상태: 부분 구현: AgentProfiles의 immutable revision·model/tool/config binding 및 durable Turn/Attempt가 있다. 한 작업 안의 계획/편집 검증별 route 선택·escalation 계약은 추가 범위다. 근거: R02, R13, R20.

독립 구현 계약:

- 호스트가 role→provider/model/config revision을 명시하고 단계 선택 이유·이전 검증 outcome·route revision을 Turn/Attempt에 기록한다.
- model 전환마다 capability/tool schema/context/output reserve를 다시 계산하고 공유 run 예산에서 비용을 차감한다. provider credentials와 tool scope는 호스트 등록 경계를 따른다.
- stronger-model 전환은 호스트의 명시적 정책에 따른 제한된 단계이며 권한 상향을 의미하지 않는다. retry의 원 요청과 다른 model route를 혼동하지 않도록 별도 attempt binding을 둔다.

검증 조건:

- 계획→작성→검증 route가 각 model metadata와 context digest로 일치한다.
- fallback/escalation 중 cancel·budget exhaustion·unknown context window·도구 capability 차이를 정확히 기록한다.
- role 변경이 Plan/Build·deny·승인 요구를 바꾸지 않으며 profile revision 변경 후 오래된 실행 설정을 재사용하지 않는다.

관련 Moodcode 경로: [packages/engine/src/agents/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/agents/index.ts:1), [packages/engine/src/runner/turn-executor.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/turn-executor.ts:1), [packages/engine/src/context/model-spec.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/model-spec.ts:1), [packages/engine/src/context/plan.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/plan.ts:1), [packages/engine/src/ports.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/ports.ts:1).

## 주요 고정 소스 근거

모든 링크는 동일 full HEAD의 1-based 줄 번호다. 아래 20개 항목은 evidence JSON과 같은 id/범위다. 본문의 추가 링크는 경계 설명을 보완한다.

| ID | 소스 범위 | 확인한 동작 |
|---|---|---|
| R01 | [app/cli/plan_exec/tell.go:134–151](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/plan_exec/tell.go#L134-L151) | TellPlan이 프로젝트 경로·autonomy·build·context 플래그를 서버 요청으로 전달한다. |
| R02 | [app/server/model/plan/tell_exec.go:177–193](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_exec.go#L177-L193) | execTellPlan이 현재 단계에 따라 architect/planner/coder 역할과 토큰 한도를 선택한다. |
| R03 | [app/server/model/plan/tell_exec.go:530–581](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_exec.go#L530-L581) | doTellRequest가 텍스트 스트리밍 요청을 만들고 CreateChatCompletionStream 후 listenStream을 시작한다. |
| R04 | [app/server/model/plan/tell_stream_processor.go:536–590](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_processor.go#L536-L590) | handleNewOperations가 파싱된 파일·move·remove·reset operation을 자동 build 큐로 보낸다. |
| R05 | [app/server/model/plan/tell_stream_finish.go:160–223](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_finish.go#L160-L223) | handleStreamFinished가 CLI context-load 응답을 기다린 뒤 willContinuePlan에 따라 다음 iteration을 실행한다. |
| R06 | [app/server/model/plan/tell_context.go:66–117](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_context.go#L66-L117) | smart context는 현재 subtask UsesFiles 밖의 일반 파일 context를 제외한다. |
| R07 | [app/server/model/plan/tell_context.go:235–260](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_context.go#L235-L260) | formatModelContext는 미적용 pending 파일 내용을 원래 context 본문보다 우선한다. |
| R08 | [app/server/syntax/file_map/map.go:17–29](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/syntax/file_map/map.go#L17-L29) | FileMap 정의는 signature·comment·line·children을 가진 구조이며 전체 구현 본문과 구분된다. |
| R09 | [app/server/db/context_helpers_update.go:264–288](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/context_helpers_update.go#L264-L288) | UpdateContexts가 path별 map 본문·입력 SHA·토큰·크기를 저장한다. |
| R10 | [app/server/db/result_helpers.go:462–496](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/result_helpers.go#L462-L496) | GetPlanResult가 pending 파일 결과와 replacements를 경로별 누적 projection으로 구성한다. |
| R11 | [app/cli/lib/apply.go:171–205](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply.go#L171-L205) | MustApplyPlanAttempt가 사용자 확인 뒤 ApplyFiles로 로컬 프로젝트에 잠정 적용한다. |
| R12 | [app/cli/lib/apply.go:399–422](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/apply.go#L399-L422) | execApplyScript는 프로젝트 root·현재 환경의 로컬 shell 프로세스를 실행하고 process/cgroup 정리 설정을 한다. |
| R13 | [app/server/model/plan/build_validate_and_fix.go:97–143](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_validate_and_fix.go#L97-L143) | buildValidateLoop는 Builder를 사용하고 3번째 시도부터 StrongModel을 선택하며 모델 valid와 문법 오류를 함께 확인한다. |
| R14 | [app/server/model/plan/build_race.go:272–299](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_race.go#L272-L299) | buildRace는 취소·실패·성공 채널을 선택하며 fallback 시작과 첫 성공 결과 반환을 조정한다. |
| R15 | [app/cli/plan_exec/apply_exec.go:142–164](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/plan_exec/apply_exec.go#L142-L164) | 실패 디버깅 callback은 TellPlan 후 MustApplyPlanAttempt를 attempt+1로 재호출한다. |
| R16 | [app/server/model/plan/stop.go:10–44](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/stop.go#L10-L44) | Stop은 summary·plan context를 취소하며 StorePartialReply는 Stopped assistant 메시지를 별도 저장한다. |
| R17 | [app/server/db/branch_helpers.go:82–96](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/branch_helpers.go#L82-L96) | CreateBranch가 plan 저장소에 Git branch를 만들고 활성 branch 수를 기록한다. |
| R18 | [app/server/db/locks.go:257–273](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/db/locks.go#L257-L273) | repo read lock은 다른 branch read 및 모든 write와 충돌하며 write는 모든 기존 lock과 충돌한다. |
| R19 | [app/server/model/plan/build_exec.go:104–128](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_exec.go#L104-L128) | queueBuild는 경로별 큐를 추가하고 같은 파일의 active build가 없으면 goroutine을 시작한다. |
| R20 | [app/server/model/client.go:57–77](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/client.go#L57-L77) | newClient가 공급자별 auth variable과 BaseURL로 OpenAI 호환 client를 구성한다. |

## 검증 범위와 남은 불확실성

- 고정 HEAD 소스만 정적 분석했다. upstream 설치·빌드·테스트·모델 호출·명령 실행·계정 연결·GUI 실행은 하지 않았다.
- README의 2M/20M context, 성능·편집 신뢰성·full autonomy는 실행으로 검증하지 않았다. 유지보수 상태는 해당 HEAD의 commit metadata와 README 고지 범위다.
- Git LFS·submodule 재귀 자료와 외부 cloud/private hook 구현, provider·LiteLLM 실제 호환성·약관·전체 dependency license audit는 확인 범위 밖이다.
- 누적 diff sandbox를 process/filesystem/network 보안 격리로 해석하지 않는다. CLI shell 실행은 사용자 환경에서 이루어진다.
- 확인한 주요 엔진에서 일반 MCP catalog/독립 하위 agent lifecycle을 찾지 못했다는 관측은 제품 전체의 부재 증명이 아니다.
- Moodcode의 기존 테스트 통과 기록은 implementation-status 문서의 이전 기록이며 이번 upstream 실행 결과가 아니다.
- 원본 source·prompt·fixture를 산출물에 복사하지 않았고 runtime dependency를 추가하지 않았다. 원본을 읽은 분석이며 clean-room 절차라고 주장하지 않는다.

정적 근거는 main 경로의 파일 존재·줄 범위·고정 commit을 재확인할 수 있다. semantic correctness, 큰 저장소 처리 성능, 모델별 사용량·요금·cache, 실제 Chrome/browser debug, cloud 운영과 분산 장애 복구는 이 보고서의 검증 결과가 아니다.
