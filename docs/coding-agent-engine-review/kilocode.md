# Kilo Code 엔진 분석

2026-10-07. 고정 소스의 정적 분석이다. 기본 CLI와 IDE가 사용하는 Kilo 수정 `SessionPrompt` 실행 루프와 같은 monorepo의 V2 `server/core` 실행 서비스를 구분한다. OpenCode fork 표시는 소스 구조·저작권·Kilo 전용 확장과 맞지만 기존 OpenCode 분석을 이 checkout에 그대로 대입하지 않았다.

| 기준 | 값 |
|---|---|
| 원본 | [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) |
| 고정 HEAD | `b1e7f34a4ce9fac0519714116f06fb553e185c56` |
| 로컬 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/kilocode` |
| 유지보수 관측 | 2026-10-07 10:36:35 +02:00의 PR #14890 merge, package 버전 7.8.7. 이 snapshot의 개발 활동이며 향후 유지보수 보장은 아님. |
| Moodcode 기준 | 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 `464812f7d1af24466f57070663131f5979aeca51`; [baseline](moodcode-baseline.md), [구현 상태](../moodcode/implementation-status.md) |
| 범위 | entry → context → provider stream → local/MCP tools → completion, 권한·취소·저장·복구·기억·child·확장·control plane |
| 분석 모드 | `static-source-review`; 원본 설치·테스트·서버·모델·계정·GUI 실행 없음 |

## 대표 고정 소스 근거

모든 링크는 위 full SHA에 고정한다. 본문 ID는 [evidence JSON](kilocode.evidence.json)의 경로·줄·SHA-256과 대응한다. 최대 160줄의 대표 근거이며 전체 정독 목록이 아니다.

| ID | 고정 소스 | 확인한 동작 |
|---|---|---|
| K01 | [README.md:118–163](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/README.md#L118-L163) | README의 기능·자동 승인·MIT·OpenCode fork 주장 |
| K02 | [LICENSE:1–22](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/LICENSE#L1-L22) | root MIT, Kilo Code와 opencode의 저작권 고지 |
| K03 | [packages/kilo-vscode/src/services/cli-backend/server-manager.ts:81–174](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/kilo-vscode/src/services/cli-backend/server-manager.ts#L81-L174) | VS Code host의 CLI serve 시작과 인증·제품·부모 PID 전달 |
| K04 | [packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:313–346](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L313-L346) | 기본 instance prompt가 SessionPrompt.Service로 진입 |
| K05 | [packages/opencode/src/session/prompt.ts:1548–1640](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/prompt.ts#L1548-L1640) | 이력 재조회·queue scope·chronology와 tool-call을 고려한 종료 |
| K06 | [packages/opencode/src/session/prompt.ts:1743–1875](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/prompt.ts#L1743-L1875) | 도구 해석·plugin transform·editor/memory/instruction/MCP 문맥·payload prune·processor 호출 |
| K07 | [packages/opencode/src/session/llm.ts:309–437](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/llm.ts#L309-L437) | native opt-in/fallback과 기본 AI SDK streamText의 model/tools/abort/출력 한도 |
| K08 | [packages/opencode/src/session/processor.ts:938–1087](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/processor.ts#L938-L1087) | event drain·network guard·interrupt·provider retry·불완전 시도 처리·continuation 결과 |
| K09 | [packages/opencode/src/session/tools.ts:101–223](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/tools.ts#L101-L223) | call별 문맥·승인 provenance·plugin 전후 hook·sandbox 실행 |
| K10 | [packages/opencode/src/kilocode/permission/provenance.ts:11–149](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/kilocode/permission/provenance.ts#L11-L149) | 규칙 출처·외부 workspace 표시·metadata 교체 때 승인 출처 보존 |
| K11 | [packages/opencode/src/tool/task.ts:197–335](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/tool/task.ts#L197-L335) | 부모 권한/sandbox 상속·자식 생성/재개·background 결과의 부모 prompt 전달 |
| K12 | [packages/opencode/src/kilocode/board/store.ts:235–339](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/kilocode/board/store.ts#L235-L339) | root board의 tool-call identity·수신자/reply·상한·transaction |
| K13 | [packages/kilo-memory/src/memory.ts:129–230](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/kilo-memory/src/memory.ts#L129-L230) | enabled 기억 색인·bounded 문맥·명시적 apply와 source/file 결과 |
| K14 | [packages/core/src/event.ts:245–364](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/core/src/event.ts#L245-L364) | durable event·projection·aggregate 순번의 immediate transaction 저장 |
| K15 | [packages/opencode/src/kilocode/session/prompt.ts:161–282](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/kilocode/session/prompt.ts#L161-L282) | session/tree 취소·drain·빈/실패 assistant tail의 제한된 복구 |
| K16 | [packages/opencode/src/session/processor.ts:588–735](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/processor.ts#L588-L735) | step 전후 snapshot·finish·usage·cost·patch 기록 |
| K17 | [packages/opencode/src/session/compaction.ts:468–578](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/compaction.ts#L468-L578) | summary assistant·payload/chunk fallback·빈 요약 거절·성공 때만 tail anchor |
| K18 | [packages/opencode/src/session/tools.ts:471–570](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/session/tools.ts#L471-L570) | MCP 변환·승인·sandbox·hooks·attachment/큰 결과 투영 |
| K19 | [packages/core/src/session/runner/llm.ts:173–328](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/core/src/session/runner/llm.ts#L173-L328) | V2 location/epoch/input 승격·LLM request·durable tool-call 뒤 settlement |
| K20 | [packages/opencode/src/control-plane/workspace.ts:559–640](https://github.com/Kilo-Org/kilocode/blob/b1e7f34a4ce9fac0519714116f06fb553e185c56/packages/opencode/src/control-plane/workspace.ts#L559-L640) | session warp의 source sync/cancel·event owner claim·변경 적용·binding |

## 제품과 package 경계

- `packages/opencode`는 TypeScript/Bun `@kilocode/cli`다. root dev script도 이 package를 실행하고 `src/index.ts`가 TUI·run·serve·ACP 등 command를 등록한다. `cli/cmd/run.ts:1084–1127`은 SDK `session.prompt`와 event drain을 연결하며 빈 assistant 응답을 성공 종료로 취급하지 않는 Kilo 코드를 포함한다.
- `packages/kilo-vscode`는 TypeScript extension host와 SolidJS webview client다. `ServerManager.startServer`가 bundled CLI의 `serve --port 0`을 시작하며 password·부모 PID·플랫폼을 전달한다(K03). Agent Manager worktree UI와 autocomplete는 client 영역이다.
- `packages/kilo-jetbrains`는 Kotlin backend/frontend와 공유 webview를 둔다. `backend/src/main/kotlin/ai/kilocode/backend/cli/KiloBackendCliManager.kt:147–165`도 `ProcessBuilder`로 CLI `serve --port 0`을 시작한다. 별도 JVM 모델 loop를 확인한 것은 아니다. IDE 실행·binary bundle은 검증하지 않았다.
- `packages/server`의 `@opencode-ai/server`는 V2 HTTP handler, `packages/core`는 session/location/event/tool/policy, `packages/llm`은 모델 전송, `packages/protocol`·`packages/schema`는 계약, `packages/sdk/js`는 client다. `opencode/src/server/routes/instance/httpapi/server.ts:197–205,337–342`가 instance와 V2 routes를 함께 연결하며 V2에는 `SessionExecutionLocal`을 제공한다.
- `kilo-gateway`, `kilo-memory`, `kilo-indexing`, `kilo-sandbox`와 `opencode/src/kilocode`는 auth/routing·기억·검색·정책을 확장한다. Kilo 변경이 기본 prompt·processor·tools에도 있으므로 OpenCode의 이름만 바꾼 엔진으로 분류하지 않는다.

## 기본 실행과 V2 실행

**기본 instance 경로.** CLI SDK → instance HTTP `session.prompt`/`promptAsync` → `SessionPrompt.prompt`(K04) → user message 기록·Kilo control ticket·prompt queue → `loop/runLoop`다. `prompt.ts:1436–1508`은 실패 tail 복구, inherited restriction을 보존하는 tools toggle merge, blocker dismissal 전에 follow-up 등록을 수행한다. `1951–1966`은 활성 stream과 inline tool이 drain된 뒤 다음 모델 경계에서 queued prompt로 넘어가며 `superseded` close reason을 남긴다. 이 queue를 Moodcode의 durable inbox와 동일한 저장 계약이라고 단정하지 않는다.

각 step은 compacted history를 재조회하고 queued prompt scope를 제한한다. chronology·현재 parent user·로컬 tool-call 존재를 함께 검사해 종료하고 subtask/compaction을 우선 처리한다(K05). model·agent step 한도를 선택해 assistant를 기록하고 `SessionTools.resolve`로 tools를 구성한다. editor context·프로젝트 기억·skill/environment·instruction·MCP instructions를 조립하고 큰 payload는 오래된 결과를 prune한 뒤 다시 구성한다(K06). provider가 보고한 context baseline도 output-token cap에 연결된다.

`SessionProcessor.process` → `LLM.Service.stream` → provider/request 준비 → **기본 AI SDK `streamText`**가 이어진다(K07). AI SDK가 호출하는 Kilo 도구 wrapper는 승인·sandbox·plugin 전후 hook을 거친다(K09). `llm.ts:459–479`는 `fullStream`을 공통 `LLMEvent`로 정규화하고 processor는 parts·reasoning·tool 결과·usage·finish를 기록한다(K08,K16). `stop/continue/compact`와 도구 결과에 따라 다음 모델 step을 결정한다. provider가 `stop`을 보내도 로컬 tool-call이 있으면 결과를 모델에 다시 전달한다(K05). `prompt.ts:1998–2040`은 drain 종료에 맞춰 turn close reason을 발행한다.

**선택 native 경로.** K07은 요청별 native 지원 gate와 AI SDK fallback을 둔다. 실제 `runtime-flags.ts:4,69`는 `KILO_EXPERIMENTAL_NATIVE_LLM` boolean, 기본 false다. 하위 AGENTS의 umbrella experimental 설명을 코드 기본값으로 사용하지 않았다. `llm/native-runtime.ts:51–72`는 provider ID·SDK package·API key·OAuth fetch override를 검사한다. 현재 코드는 fetch override가 있는 OpenAI OAuth 예외를 허용하므로 모든 OAuth가 무조건 fallback이라는 지침 설명도 일반화하지 않는다. `native-runtime.ts:104–135`는 native event와 도구 dispatch/settlement를 동일 wrapper에 연결한다. 실제 계정 조합은 미검증이다.

**별도 V2 경로.** `packages/server/src/handlers/session.ts:145–175`는 `SessionV2.prompt`에 durable input ID·delivery·resume를 전달한다. `core/session/execution/local.ts:10–36`의 local coordinator가 location layer에서 `SessionRunner.run`을 실행한다. runner는 location binding·context epoch·baseline·steer/queue 승격·model/tool materialization으로 `LLM.request`를 구성한다(K19). tool-call은 먼저 durable publish한 뒤 local settle fiber를 시작하고 provider-executed call은 로컬 재실행하지 않는다. stream과 settlements를 기다린 후 `runner/llm.ts:391–413`이 tool continuation·steer·queue를 처리한다. V2에도 overflow compaction과 snapshot이 있지만 기본 Kilo 경로의 plugin/MCP/goal/board/memory·복구 의미를 전부 지원한다고 인증하지 않았다. 소스의 미완료 checklist만으로 이미 있는 실행 코드까지 미구현이라고 판정하지 않았다.

## 주요 기능과 확인 한계

| 범주 | 실제 소스에서 확인 | 해석·한계 |
|---|---|---|
| context·summary | compacted history, 현재 queue scope, editor·skill/instruction·MCP 문맥(K05,K06). 별도 summary assistant·payload/chunk fallback·빈 summary 거절·성공 시 tail anchor(K17). | 세션 요약과 프로젝트 기억은 별도. 요약 정확성·모든 tool exchange의 provider replay 호환성을 실험하지 않음. |
| project memory | enabled gate, stale/expired index rebuild, capped bytes/token 추정과 source/file 결과를 가진 apply(K13). `kilocode/session/prompt.ts:392–442`는 세션별 memory block을 pin하고 bounded cache 사용. | `memory/turn.ts:35–99`가 turn close를 capture에 연결. `kilo-memory/src/effect/capture.ts:319–453`는 bounded evidence·typed JSON parse/dedup·digest/consolidation 별도 모델 호출·자동 hard remove 제외를 구현. 사실 정확성·secret filter 완전성은 미검증. |
| search | read/glob/grep 및 `kilocode/indexing.ts:521–587`의 VS Code project consent·worker 상태·vector search. `kilo-indexing/src/indexing/worktree-overlay.ts:48–90`는 baseline hash·changed/blocked 경로를 검사해 stale 결과를 제외. | embedding·vector store·catalog는 설정/외부 서비스에 의존. 검색 품질·index 갱신 속도 실측 없음. |
| edit·command·verification | registry가 model/agent/policy별 도구를 구성하고 K09 wrapper를 실행. `tool/write.ts:45–102`는 encoding/BOM 보존·diff 승인·formatter·LSP 진단. `tool/edit.ts:62–123`는 경로 lock·입력 검증. shell/apply_patch/diagnostics/LSP 도구도 있음. | formatter/LSP 결과를 다음 step에서 참고하는 구조. README의 self-checking(K01)을 모든 과업에서 테스트를 반드시 실행하는 계약으로 해석하지 않음. Moodcode prepared fingerprint와 승인 구조가 같다고 주장하지 않음. |
| permission | call별 ask가 agent/session 정책을 다시 읽고 승인/거절 provenance를 metadata에 기록(K09,K10). `permission/index.ts:187–282`는 hard Ask/Plan veto·protected config/skill-shell/sandbox escalation ask·pending cleanup. | README auto 승인(K01)에 실제 예외가 있음. `reply`는 민감한 요청의 interactive human 여부도 검사. 기존 Moodcode deny/exact approval/grant를 바꾸는 제안이 아님. |
| cancel·recovery | session/tree 구분, child 순회·queue/intake/plan follow-up cancel·drain·Interrupted(K15). processor stream abort·offline guard·provider retry·불완전 응답 cleanup(K08). | follow-up 전에 제거하는 것은 idle이고 빈/보이는 결과 없는 실패 tail뿐. 도구·파일 효과가 있었던 기록을 보존하는 guard 있음. 원격 효과 exactly-once나 Moodcode native receipt 수준 crash frontier는 입증하지 않음. |
| storage·replay | `session.ts:758–781` message/part event → core EventV2 bridge. durable event projection·aggregate 순번·event row의 immediate transaction(K14). | SQL 기록과 volatile 실행 owner·live approval waiter 재개는 구분. 모든 crash가 자동 재개 가능하다는 뜻이 아님. |
| checkpoint·restore | step 전후 snapshot과 patch·usage·finish 저장(K16). Kilo snapshot track에는 큰 repo 지연의 wait/skip/project-disable 정책. | Git/file diff 영역이며 command/network 외부 효과의 rollback은 아님. Moodcode checkpoint/restore는 이미 구현됨. |
| child·board | parent 권한·sandbox ceiling 상속, 자식 생성/재개, background 결과의 parent synthetic prompt delivery(K11). board는 root recipient/reply·중복 제거·count/bytes·transaction(K12). | task 경로 자체는 같은 instance의 자식 세션이고 worktree 생성이 확인되지 않음. IDE Agent Manager worktree와 분리. `runtime-flags.ts:48–62`는 background/board 기본 true지만 profile/config opt-out이 적용됨. |
| MCP·plugin | MCP convert·policy ask·sandbox network authority·hooks·attachment 제한·큰 결과 truncate(K18). `mcp/catalog.ts:18–81`는 cursor 순환 방지·timeout/progress·abort. | `plugin/index.ts:160–262`의 internal auth plugins·외부 load·순서가 있는 hooks·workspace adapter 등록. Moodcode host plugin·MCP catalog/resources·bounded discovery는 이미 있음. mutable hook를 승인 우회로 도입하지 않음. |
| provider·services | `provider/provider.ts:1648–1748`은 config/env/auth/plugin·Kilo custom loader와 OAuth source를 병합. K07은 transform·model/abort/output 한도 연결. | 500+ 모델·가격·Cloud Agent·Marketplace·자동완성·브라우저 제품 경험은 README/외부 서비스 범위. provider별/OS별 실측 없음. |
| control plane | warp가 이전 target sync 또는 local cancel 후 event owner claim, 선택 파일 변경 적용, workspace binding 갱신(K20). | local/remote workspace adapter·history sync가 존재. 일반 task의 worktree 생성과 다름. remote 서비스·이동 crash·분산 ownership을 실험하지 않음. |

## Moodcode 독립 구현 후보

Moodcode의 영구 queue/steer inbox·pause/resume, profiles, read-only delegation·worktree child·예산/deny/cancel 상속, terminal delivery, tools 없는 summary·active-prefix, exact approval·grant, checkpoint/restore, host plugin·MCP·bounded discovery는 기존 기능이다. 후보는 추가 계약이며 이번 변경에서 구현하지 않았다.

| 후보 | 현재 기능과의 차이 | 독립 계약·우선순위·비용 | 검증 조건 |
|---|---|---|---|
| K-C01 root 공유 board | terminal child 결과 전달과 task CAS 위에 살아 있는 sibling 메시지/cursor 추가(K11,K12). | **P2 / M–L.** host root/sender binding, 동일 call retry receipt와 변경 conflict, root 수신자/reply, bounded cursor·clear revision·저장/문맥 quota. 다음 모델 경계에서 data 전달. read-only child 쓰기는 별도 host grant. | 동시 sibling·root 경계·stale cursor·재시작·cancel·overflow·기존 terminal delivery 회귀. |
| K-C02 승인된 project memory publication | 세션 summary와 별도 source-backed 사실의 project revision·publication 승인(K06,K13,K17). | **P2 / L.** source session/message/hash·모델·시각 proposal, 추가/수정/삭제 exact preview 승인·CAS. secret rejection·raw output 복제 금지, 승인 revision을 세션 context에 pin. 기억으로 정책 확대 금지. | stale revision/approval·실패/빈 결과/cancel/crash·source 변경·secret·pinned context·summary 복구 회귀. |
| K-C03 승인 판단 provenance | 기존 reason/policy version·deny·exact approval·scoped grant 유지, rule/grant/manual 출처 추가(K09,K10,K18). | **P1 / M.** resource별 bounded decision list·rule ID·policy revision·grant consume receipt. denial도 기록. 명령 원문/credential 제외. 관측 metadata는 fingerprint·권한 변경 불가. | resource별 분류·grant 철회/policy 변경/stale prepare 차단·metadata 교체/retry/archive 보존·redaction·MCP recovery 회귀. |

실제 연결 경로와 자세한 contract·검증 조건은 evidence JSON의 candidate에 기록했다. board는 `child-tasks/index.ts`·`runner/input-scheduler.ts`·`storage/native.ts`, project memory는 `context/semantic-memory.ts`·`context/service.ts`·`permission/index.ts`, provenance는 `permission/policy.ts`·`permission/grants.ts`·`runner/index.ts`를 비교했다. 일반 lifecycle hook나 MCP를 신규 기능으로 중복 제안하지 않는다.

## license·출처·검증 한계

README의 MIT/OpenCode fork 표시는 root MIT와 Kilo Code 2026/opencode 2025 저작권 고지에 부합한다(K01,K02). 직접 읽은 `packages/kilo-vscode/LICENSE`도 두 고지를 유지하고 `packages/ui/LICENSE`·`packages/http-recorder/LICENSE`는 opencode 2025의 MIT다. 네 파일의 hash는 evidence에 기록했다. root/package 표기만으로 문서·미디어·vendor·전이 의존성이 전부 MIT라고 판정하지 않는다. cloud/gateway·model provider·embedding/vector store·Marketplace·IDE 플랫폼은 별도 서비스/배포 영역이며 전체 license audit 또는 법률 검토는 아니다.

이번 검증은 고정 HEAD의 파일·줄 범위·hash·commit membership와 Moodcode candidate 경로의 정적 검사다. 원본 설치/test/benchmark/모델/credential/GUI/OS별 build/remote workspace 실험 결과는 없다. Moodcode의 기존 1차 테스트 기록은 비교 기준으로만 사용한다. snapshot·sandbox·memory redaction·plugin trust·MCP cancellation의 보안 완전성을 입증하지 않았고 선택 범위에 못 찾은 기능을 제품 전체에 없다고 단정하지 않는다.

[기존 OpenCode 보고서](../opencode-engine-review/README.md)는 배경이다. 현재 Kilo 전용 board/memory/provider/sandbox/queue/복구 경로를 직접 읽었으며 전체 fork diff 또는 전 package parity audit은 아니다. 원본·HEAD를 변경하지 않았고 Moodcode에는 담당한 보고서와 evidence만 추가했다. source/prompt/tool description/fixture·runtime dependency를 옮기지 않았다. 원본을 읽은 분석이므로 clean-room 절차를 주장하지 않는다.
