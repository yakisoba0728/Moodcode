# OpenCode 엔진 검토 03 — 도구, 권한, 로컬 실행과 확장

검토일: 2026-10-07. 기준 소스: OpenCode `dev`의 `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`. 원본 checkout은 `/Users/yakisoba0728/Documents/GitHub/opencode-engine-reference-4ac0d9c3d1`이다. Moodcode 비교 기준은 기존 자체 엔진의 `6d9a952`이다.

이 문서는 소스와 테스트 본문을 읽은 정적 분석이다. 이 검토에서는 OpenCode/Moodcode 테스트 실행, 의존성 설치, 앱 실행, 모델 요청을 하지 않았다. 테스트는 구현 의도를 확인하는 근거이며 이번 checkout에서 통과했다는 뜻이 아니다. 파일별 실제 읽기 범위와 SHA-256은 [coverage](03-tools-permissions.coverage.json)에 기록했다. 도구 설명, 시스템 프롬프트, 구현 함수, 테스트 fixture를 Moodcode에 옮기지 않았다.

## 먼저 확인한 결론

OpenCode에는 도구 실행 경계가 서로 다른 legacy 엔진과 native V2 엔진이 함께 있다. legacy는 MCP, plugin 도구, task/subagent, formatter/LSP, shell parser까지 연결되어 있다. native V2는 명시적인 도구 등록과 durable settlement를 갖췄지만 같은 기능 전체가 이식된 상태는 아니다. Moodcode가 배울 대상은 두 구현의 동작 계약과 실패 처리이며 어느 한쪽 디렉터리를 통째로 가져오는 방식이 아니다.

native V2의 `BuiltInTools`가 등록하는 도구는 **12개**다: read, glob, grep, edit, write, apply_patch, bash, question, skill, todowrite, webfetch, websearch. task, LSP, repo 도구, plan 전환, code mode/Rune, MCP/plugin 도구 등록은 이 목록에 없고 일부는 명시적 TODO다. 이 숫자는 전체 OpenCode 제품의 도구 수를 뜻하지 않는다. [native builtins와 남은 이식 범위](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/builtins.ts#L17-L48)

Moodcode에는 이미 읽기/목록/문자열 검색, hash로 묶인 파일 변경 승인, command supervisor, durable 승인, checkpoint와 충돌 검사 복원이 있다. 이 토대를 유지하면서 작은 편집, 도구 카탈로그 수명, 질문/입력, 정책, 확장을 순서대로 추가하는 편이 적합하다. OpenCode의 더 넓은 host 권한이나 느슨한 전체 파일 overwrite까지 그대로 맞출 이유는 없다.

## 실제 호출 경로

| 경계 | legacy | native V2 |
|---|---|---|
| 모델에 보일 도구 구성 | `SessionPrompt` → `SessionTools.resolve` → legacy registry + MCP | Location service 구성 → BuiltInTools 등록 → provider turn별 registry materialization |
| 정의/실행 객체 | parameters, string output, metadata, attachments | canonical opaque Tool 값, input/output codec, structured output와 model content projection |
| 권한 호출 | 도구의 `ctx.ask`, agent와 session 규칙 결합 | leaf가 Location의 PermissionV2를 획득하고 invocation identity와 함께 assert |
| 실행 진행 표시 | tool metadata callback과 before/after plugin hook | runner가 tool-call event를 기록하고 eager fiber로 실행; generic invocation progress는 TODO |
| settlement | processor의 tool part와 AI SDK adapter | registry settlement → publisher tool-result → durable event/projection |
| 확장 도구 | JS/TS 파일, plugin 도구, MCP tools/resources | application/Location canonical 등록 API; legacy MCP/plugin 도구 자동 등록과 동등하지 않음 |

legacy의 최신 주요 연결은 `session/prompt.ts` 안에만 있지 않고 `session/tools.ts`로 분리되어 있다. prompt가 resolve를 호출하고 builtin 실행, MCP resource/list/template/read, plugin before/after hook과 AbortSignal을 구성한다. code mode가 켜지면 MCP 도구를 직접 모델에 나열하는 루프를 건너뛴다. [prompt의 연결](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/prompt.ts#L1226-L1242), [legacy tool/MCP adapter](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/tools.ts#L41-L130), [MCP 직접 호출 연결](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/tools.ts#L388-L490)

native V2는 `location-services.ts`에 ToolRegistry, BuiltInTools, Permission, Question, Pty, Snapshot과 runner가 함께 연결되어 있다. runner는 한 provider turn의 도구 정의를 고정하고 tool-call을 먼저 publish한 뒤 로컬 도구 실행을 시작한다. 같은 turn에서 기록된 도구는 eager fiber로 실행될 수 있고, continuation 전에 전체 settlement를 기다린다. 중단/사용자 거절/defect를 일반 성공 결과로 덮지 않는다. 따라서 도구가 많아졌을 때 쓰기 충돌과 승인 대기도 별도 실행 정책으로 정의해야 한다. [Location wiring](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/location-services.ts#L42-L80), [runner의 정의 고정과 실행](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L207-L278), [settlement와 중단](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L285-L345)

## 도구 등록의 수명과 카탈로그

native 도구는 입력 decode → execute → 출력 encode → model projection 순서다. registry는 이를 하나의 representation으로 취급하며 별도 plugin용 executor를 섞지 않는다. 일반적인 입력/출력 검증 실패는 모델이 다시 시도할 수 있는 tool failure로 변환한다. interruption과 defect까지 같은 실패 문자열로 삼키는 경계는 피한다. [canonical tool 경계](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/tool.ts#L73-L138), [registry의 typed failure 처리](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/registry.ts#L50-L90)

application 등록은 process scope에서 공유하고 Location 등록이 같은 이름의 application 도구를 덮는다. 같은 placement 안에서는 가장 최근 활성 등록이 이긴다. registration scope가 닫히면 해당 등록만 사라지고 앞선 등록이 다시 드러난다. application-tools 파일만 보면 Map 덮어쓰기처럼 보이지만 실제 cleanup은 하위 `State.transform`의 scoped transform replay와 finalizer에 있다. 표면적인 코드만 읽고 cleanup 누락으로 판단하면 잘못된 결론이다. [application 등록](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/application-tools.ts#L32-L53), [State scope cleanup](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/state.ts#L95-L128)

provider turn에서 광고한 등록 identity가 도구 호출 시작 전에 교체/해제되면 stale call로 거절한다. 이미 실행을 시작해 capture한 도구는 이후 등록 변경으로 다른 executor로 바뀌지 않는다. 이름이 같다고 다른 plugin 버전의 handler를 실행하는 것을 막는 중요한 경계다. [identity 검증과 materialization](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/registry.ts#L50-L137), [stale/overlay/실행 중 교체 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/session-runner-tool-registry.test.ts#L336-L445)

도구 정의를 모델 카탈로그에서 숨기는 것은 실행 authorization이 아니다. native registry 자체는 Permission service에 의존하지 않는다. edit/write/apply_patch는 카탈로그상의 permission action을 edit로 공유하지만 실제 부작용 직전 권한 확인은 leaf 책임이다. application 도구도 등록만으로 자동으로 안전해지지 않는다. Moodcode에서는 현재 중앙 durable 승인 gate와 도구의 prepared-input 재검증을 유지하고, 외부 도구 계약에 policy 선언을 필수화하는 것이 좋다. [native 정책 경계 지침](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/AGENTS.md#L43-L47), [카탈로그 필터와 실행을 분리한 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/application-tools.test.ts#L90-L109)

## 승인과 질문은 다른 대기 상태다

native Permission은 action/resource에 대해 마지막으로 매칭한 wildcard 규칙을 사용하고 기본값은 ask다. 선택한 agent가 없으면 deny 규칙으로 제한한다. configured deny를 먼저 검사하므로 저장된 always 허용으로 configured deny가 뒤집히지 않는다. saved allow는 project별 SQL row이며 request의 save resource를 보존한다. pending 승인 자체와 deferred waiter는 Location 메모리에 있다. Event.Asked가 기록되는 것만으로 재시작 후 실행 waiter가 복원되지는 않는다. [규칙과 평가](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/permission.ts#L76-L167), [saved allow 저장](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/permission/saved.ts#L35-L75)

권한 답변은 once/always/reject다. reject는 같은 session의 다른 pending 승인도 정리하고, feedback이 있으면 수정 피드백으로 분리한다. always는 저장 규칙으로 다른 pending 요청이 모두 허용되는지 재평가하여 풀 수 있다. Location 종료 시 pending deferred가 실패한다. legacy always 승인은 이와 달리 InstanceState의 approved 배열에 머물고, 해당 서비스 코드에서 durable SQL 저장을 하지 않는다. [native reply](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/permission.ts#L179-L281), [legacy pending/always](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/permission/index.ts#L42-L168)

질문은 Question service가 별도 request ID, 질문 목록, answer 배열, reject를 관리한다. question tool은 권한을 먼저 확인한 다음 질문 대기에 진입한다. Question pending도 Location 메모리이고 종료 시 reject된다. 서로 다른 Location의 응답이 다른 waiter를 풀지 않도록 각 layer instance가 pending을 소유한다. [Question lifecycle](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/question.ts#L74-L153), [question leaf 연결](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/question.ts#L50-L88)

Moodcode ApprovalManager는 request/decision/expiration을 durable store에 남기고 fingerprint로 실제 준비된 실행에 묶는다. resolved 승인을 다른 실행에 재사용하지 않고 live waiter가 없어진 pending은 expire한다. 이 구조는 보존해야 한다. 새로운 policy always 허용은 기존 일회성 fingerprint 승인과 별도로 기록하고, 질문에도 질문 ID/session/run/call identity 및 재시작 후 expired 정책을 정의한다. [Moodcode durable approval](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/permission/index.ts:53)

## 파일 도구와 부작용 경계

| 도구 | native V2에서 확인한 동작 | legacy와 차이 / Moodcode 설계 선택 |
|---|---|---|
| read | text/directory paging, 지원 이미지 normalize, binary/UTF-8/ingest 제한 | Moodcode read_file의 whole-file hash와 변경 시 continuation 무효화 유지. 이미지가 필요할 때 독립 media adapter 추가 |
| glob/grep | ripgrep를 사용한 검색; 모델 출력과 structured output 구분 | Moodcode의 literal search는 이미 있음. bounded glob/regex 검색을 별도 명세로 추가 |
| edit | 정확한 oldString 교체; no-op/empty/모호한 다중 매치 거절; BOM/CRLF 보존 | legacy에는 여러 fuzzy matcher가 있음. Moodcode는 expectedHash 기반 exact span 편집을 먼저 자체 구현 |
| write | edit 권한 뒤 BOM을 보존한 전체 덮어쓰기 | Moodcode full-content apply_patch로 기능 가능. 별도 write alias가 필요하면 동일 승인/expectedHash 경계를 사용 |
| apply_patch | 대상 모두 resolve/승인 후 prepare, add/update/delete 순차 적용, move 거절 | legacy move 지원. native도 원자적 rollback 없음. Moodcode partial checkpoint와 실패 accounting 유지 |
| skill/todowrite | permission 후 skill content 또는 session todo 업데이트 | Moodcode에는 아직 전용 도구 없음. 읽기 context와 session data mutation의 정책을 분리 |
| webfetch/websearch | permission 후 제한된 HTTP 응답 처리; 외부 검색 provider 연결 | 임의 MCP 연결과 다른 shipped leaf다. Moodcode 필요 범위와 network policy를 명세한 뒤 추가 |

native 읽기는 기본 2,000줄/50 KiB, 이미지 ingest 20 MiB 제한을 둔다. 작은 text도 streaming UTF-8 decode를 사용하고 큰 text는 line offset/next를 제공한다. directory list는 전체 항목을 모아 정렬한 다음 page를 고르므로 반환량 제한과 처리량 제한은 다르다. glob/grep의 leaf 기본 limit은 매우 크며 underlying search 구현의 제한과 별도로 봐야 한다. [read filesystem](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/read-filesystem.ts#L11-L17), [text와 directory paging](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/read-filesystem.ts#L208-L352), [grep leaf](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/grep.ts#L80-L126)

native LocationMutation은 relative escape와 내부 symlink의 Location escape를 거절한다. explicit absolute 외부 경로에는 external_directory 승인을 따로 요청할 수 있다. 기존 경로 또는 가장 가까운 실제 directory를 canonicalize하여 permission resource를 만든다. Moodcode는 현재 workspace 상대경로 경계를 사용하므로 외부 capability를 추가하려면 사용자 설정과 실행 대상 identity를 먼저 설계해야 한다. [canonical 경로와 승인 resource](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/location-mutation.ts#L90-L161)

native FileMutation은 canonical path별 process-local lock 아래 conditional write를 수행한다. 현재 bytes가 준비 시 읽은 bytes와 다르면 stale을 거절한다. 이것은 협력하는 process-local 실행 사이의 보호다. 다른 프로그램의 동시 파일 수정과 crash까지 원자 transaction으로 만드는 계약은 없다. native apply_patch 역시 각 파일의 순차 부작용이며 뒤에서 실패하면 앞에서 적용한 파일을 되돌리지 않는다. typed failure에는 일부 적용 목록이 포함될 수 있지만 defect가 발생하면 앞선 부작용이 남은 채 interruption/defect가 전파된다. [file mutation](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/file-mutation.ts#L71-L179), [patch ordering](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/apply-patch.ts#L70-L189), [partial defect 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/tool-apply-patch.test.ts#L374-L436)

legacy edit는 per-path lock, diff 승인, formatter, watcher event, LSP diagnostics를 연결한다. 그러나 해당 접근 중 일부는 파일 첫머리에 다른 프로젝트를 참조했다고 밝히고 있다. 이런 matcher 함수나 학습용 프롬프트를 옮기지 않고 **hash가 일치하는 정확한 범위 변경 → 모호하면 거절 → 사용자에게 변경 diff 표시**라는 새 명세로 구현한다. [legacy edit의 provenance와 통합](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/edit.ts#L1-L20), [legacy edit commit flow](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/edit.ts#L124-L207)

Moodcode patch는 전체 변경 파일을 사전 검증하고 승인 fingerprint에 session/run/call/workspace/실행 lock을 결합한다. 실행 후 실제 before/after와 incomplete 상태를 기록하며 이미 생긴 부작용의 accounting에는 cancellation을 그대로 적용하지 않는다. 원자 rollback은 Moodcode도 지원한다고 주장하지 않는다. 더 작은 편집 도구를 만들더라도 이 구현으로 최종 commit과 checkpoint를 모으는 것이 적합하다. [Moodcode patch 준비와 실행](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/patch/index.ts:237)

## shell과 PTY의 소유권

native bash는 LocationMutation으로 workdir를 확인하고 외부 workdir 승인 후 command 전체 문자열에 bash 권한을 묻는다. timeout은 기본 2분/최대 10분, process capture는 1 MiB다. AppProcess는 scoped spawn과 timeout/AbortSignal을 결합한다. POSIX detached group, Windows taskkill, TERM 후 force kill의 실제 구현은 CrossSpawnSpawner에 있다. 종료가 이미 관측되면 일부 finalizer 경로는 종료 code에 따라 행동을 달리하므로 반환된 code 0만으로 모든 descendant 종료를 확인했다고 해석하면 안 된다. [native bash 실행](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/bash.ts#L118-L200), [process cleanup 구현](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/cross-spawn-spawner.ts#L292-L437)

native bash의 command argument에서 외부 절대경로를 찾는 로직은 **advisory**다. 파일시스템·네트워크·프로세스 authority는 host user의 권한이다. 그 scan으로 shell sandbox를 만들었다고 볼 수 없다. parser-based approval reduction, prefix always 승인, shell별 Windows 처리, plugin environment hook, durable/live progress, background owner/restart recovery, full output streaming은 TODO다. [명시적 parity debt](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/bash.ts#L65-L83), [advisory만 수행하는 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/tool-bash.test.ts#L313-L344)

legacy shell은 tree-sitter Bash/PowerShell에서 command와 일부 path argument를 추출하고, reusable command prefix와 external-directory 승인을 요청한다. shell.env plugin hook, 장시간 metadata update, bounded tail preview와 full output 파일을 연결한다. 하지만 동적 shell expansion까지 완전하게 해석하는 권한 sandbox는 아니다. [parser와 승인](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/shell.ts#L278-L328), [실행/출력/cancel](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/shell.ts#L429-L604)

PTY는 command tool과 다른 Location service다. stdin write/resize, retained output cursor, replay 이후 activate, exited session 관측을 제공한다. 메모리 buffer는 2 MiB, exited terminal은 25개까지 보존한다. 종료/삭제/Location teardown에서 subscriber를 마무리한다. native create에는 command/cwd/env가 들어가고 이 leaf 내부의 PermissionV2 gate는 없다. Moodcode가 PTY를 추가할 때 user terminal와 model command의 authority, owner, restart, attach ticket을 먼저 구분해야 한다. [PTY buffer와 contracts](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/pty.ts#L14-L69), [create와 replay attach](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/pty.ts#L162-L312)

Moodcode command는 현재 POSIX process group에 한정하고 supervisor와 실행 lock, output byte accounting, cleanupConfirmed를 다룬다. shell이 끝난 뒤 descendant가 남으면 정리하며, completion이 사라지거나 cleanup이 불확실하면 lock의 불확실성을 유지한다. provider credential은 command 환경에서 제외한다. 이 계약을 유지하고 Windows Job Object/PTY는 독립 실행 backend로 추가한다. [Moodcode command settlement](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/command/index.ts:325), [환경과 process group](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/command/process-control.ts:18)

## 출력 저장과 checkpoint/복원

native ToolOutputStore는 기본 2,000줄/50 KiB model preview와 full text 관리 파일을 분리하고 7일 retention을 사용한다. capture 제한과 모델 출력 제한은 다른 것이다. 예를 들어 bash에서 1 MiB 이후 버린 bytes는 이 store가 복구할 수 없다. 또한 generic bounding 뒤에도 structured output은 그대로 남으므로 모든 데이터의 메모리/저장량이 이 50 KiB로 제한된다고 해석하면 안 된다. 파일 콘텐츠, media, structured output, artifact bytes 각각 상한이 필요하다. [출력 경계](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool-output-store.ts#L135-L173), [retention](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool-output-store.ts#L178-L210)

native leaf의 snapshot/undo TODO는 엔진 전체에 Snapshot이 없다는 뜻이 아니다. 실제 core Snapshot 서비스가 Git tree를 content-addressed ID로 capture하고 runner는 provider turn 시작/끝 capture와 changed file 목록을 Step.Ended에 연결한다. capture는 Git/snapshots 지원 범위 안에서 best effort이며 실패하면 undefined다. 선택 복원/preview/checkout도 존재한다. caller의 복원 확인/실행 격리 정책은 별도다. [native snapshot](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/snapshot.ts#L129-L224), [runner step 종료 snapshot](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L325-L345)

legacy snapshot도 사용자 repo index와 분리된 Git directory를 사용하고 revert할 파일을 선택한다. tree에 원래 존재하지 않았던 변경 파일은 삭제할 수 있고, 원래 존재했는데 checkout이 실패한 파일은 유지한다. 이 코드를 그대로 복사할 필요 없이 Moodcode의 checkpoint restore 충돌 검사와 새 preview 승인에 대응시킬 수 있다. snapshot은 외부 파일, 서버 변경, 네트워크 전송, DB 변경을 되돌리는 보편적인 transaction이 아니다. [legacy capture/restore/revert](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/snapshot/index.ts#L320-L440), [Moodcode 복원 preview](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/index.ts:411)

## task, MCP, plugin, LSP와 worktree

legacy task는 child session을 생성하거나 task_id로 이어가고 agent/model/variant를 선택한다. parent-chain depth limit, task 권한, child session permission, foreground cancel chain을 갖춘다. experimental background task는 BackgroundJob에 연결하고 completion을 parent synthetic input으로 전달한다. nested execution ownership, depth/budget, 충돌 없는 workspace placement를 Moodcode 계약으로 먼저 정의할 필요가 있다. native BuiltInTools에는 아직 task leaf가 없다. [legacy task 제한과 child session](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/task.ts#L107-L207), [background result와 foreground cancel](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/task.ts#L224-L353)

legacy MCP는 local stdio와 remote StreamableHTTP/SSE fallback, OAuth 상태, 연결별 tool catalogue/cache/list 변경, resource/template/prompt 조회, cleanup을 가진다. SessionTools가 실제 permission과 tool/result projection을 추가한다. 연결 서비스와 coding loop를 한 객체에 합치지 않는 경계가 핵심이다. code mode는 노출된 MCP catalog의 도구를 interpreter orchestration 안에서 호출하고 각 child call에도 permission/before/after hook/AbortSignal을 건다. 이 검토는 interpreter의 sandbox 강도를 검증한 것이 아니다. [MCP transports](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/mcp/index.ts#L218-L377), [catalog와 resource APIs](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/mcp/index.ts#L666-L783), [code mode child call 정책](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/code-mode.ts#L135-L184)

legacy plugin 도구는 설정 directory의 JS/TS module과 plugin hook.tool에서 수집하고 Zod/JSON schema를 registry 경계에서 adapter로 감싼다. native PluginV2는 scope 기반 agent/model/catalog/command/integration/reference/skill transform을 가진다. 이 서비스가 Location에 등록됐다는 사실만으로 legacy custom tool, shell.env, tool.execute hook까지 native runner에 붙었다고 주장할 수 없다. canonical plugin tool boot는 tool AGENTS의 Current Gaps에도 명시되어 있다. [legacy custom tools](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/registry.ts#L127-L210), [native plugin lifecycle](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/plugin.ts#L43-L143), [현재 tool integration gap](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/AGENTS.md#L56-L59)

legacy LSP는 file extension/root/server ID별 client를 만들고 같은 spawn을 공유하며 실패 server를 broken으로 기억한다. read에서 optional warm-up, edit/write/patch에서 document notification과 diagnostics가 연결된다. native file leaves에는 이 통합이 TODO다. Moodcode에는 engine-side LSP process/RPC/diagnostics port부터 필요하고 editor UI는 그 다음이다. [LSP 수명과 spawn deduplication](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/lsp/lsp.ts#L138-L283)

legacy worktree 서비스는 이름/branch/path 생성, git worktree 생성, Instance bootstrap, start command, ready/failure, remove/reset을 분리한다. create의 반환은 fork된 boot/startscript 완료를 뜻하지 않는다. Moodcode는 worktree 생성/실행/검증/결과 merge를 별도 durable state로 기록하고 사용자 수정 보존 정책을 정의해야 한다. OpenCode 함수 이름을 맞추는 것이 목표가 아니다. [생성과 async boot](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/worktree/index.ts#L214-L293)

## 독립 구현 순서와 검증 기준

| 순서 | Moodcode 추가 범위 | 완료 기준 |
|---|---|---|
| 1 | 작은 exact edit, bounded glob/regex, 도구 결과/오류/취소 계약 | expectedHash stale 거절, 모호한 span 거절, BOM/CRLF, 동일 prepared effect 재실행 금지, partial checkpoint |
| 2 | 도구 카탈로그와 scoped 등록/version identity | provider turn이 광고한 handler만 실행, 교체/해제는 stale, 실행 중 handler mutation 없음, cleanup 후 앞선 overlay 복원 |
| 3 | action/resource policy와 질문 lifecycle | configured deny 우선, 저장 허용 범위 표시/삭제, 실제 invocation에 정책 결합, 취소/재시작 후 stale 답변 거절 |
| 4 | output/artifact store와 단일 workspace 변경 이벤트 | producer/model/artifact/media 상한 분리, partial accounting, 파일 변경 → observer/review/후속 LSP 연결 |
| 5 | PTY 및 Windows 실행 backend | user terminal/model command 소유권 구분, replay cursor, attach cleanup, group/job 종료 확인, restart 동작 명세 |
| 6 | MCP와 제한된 확장 runtime | 연결 수명/transport/OAuth/abort, schema 검증, resource와 tool policy, catalogue 교체의 stale call, scope 종료 cleanup |
| 7 | child task/worktree/LSP/formatter | budget/permission 상속, child cancel chain, workspace 충돌 정책, 결과 전달의 중복 방지, spawn/diagnostics timeout |

이 표는 모두 즉시 만드는 목록이 아니다. 사용자의 엔진 우선 목표에 맞춰 1~4에서 코딩 loop의 계약을 안정화하고 5~7은 그 위에 연결한다. 특히 기존 durable approval·prepared fingerprint·checkpoint·실행 lock을 새 도구에서도 재사용하면 초기 구현을 다시 갈아엎을 필요가 줄어든다.

이번에 읽은 upstream 테스트 근거는 application 등록의 scope 복원, registry stale advertisement, permission configured deny와 saved allow, edit 동시 변경과 BOM/CRLF, apply_patch의 partial defect와 interruption, bash advisory와 timeout, question Location 격리, PTY/snapshot lifecycle이다. 이름만 존재하는 테스트와 본문까지 읽은 테스트를 coverage에서 구분했다. 실제 실행 통과 결과는 별도 검증 단계에서 기록해야 한다.
