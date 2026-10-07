# Crush 엔진 정적 분석

2026-10-07. Crush는 Go 애플리케이션에서 세션 실행·큐·영구 대화·승인·코딩 도구를 관리하고, 모델과 도구의 반복 호출은 외부 `fantasy` agent에 맡긴다. Moodcode에 참고할 부분은 읽기 LSP navigation, 결과를 포함한 반복 상호작용 탐지, background command의 사용자 경험, 도구 정책 hook이다. 기존 Moodcode의 queue·summary·profiles·read-only child·MCP·PTY·LSP·plugin hook·복구를 새 기능으로 제안하지 않는다.

## 원본과 검토 경계

| 항목 | 고정 기준 |
|---|---|
| 저장소 | [charmbracelet/crush](https://github.com/charmbracelet/crush) |
| HEAD | `140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5` |
| 원본 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/crush` |
| 언어·package | `github.com/charmbracelet/crush`, Go `1.27.0`; `internal/cmd` → `app`/`workspace` → `agent` → `agent/tools`, `permission`, `message`, `session`, `db`, `shell`, `lsp` |
| 외부 경계 | `go.mod`의 `fantasy v0.45.1`, `catwalk v0.52.49`, MCP Go SDK, Bubble Tea, SQLite driver/goose, mvdan POSIX shell. 이 clone에 들어 있지 않은 dependency 구현은 검토하지 않았다. |
| 유지보수 단서 | 고정 HEAD의 commit 일시 `2026-10-06T18:42:30-04:00`; 제목은 세 플랫폼 CI 간헐 실패 수정이다. 최근 변경이 있는 checkout이라는 단서이며 최신 release·지속 유지보수·품질을 보증하지 않는다. |
| Moodcode 비교 | 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 `464812f7d1af24466f57070663131f5979aeca51`; [baseline](moodcode-baseline.md), [현재 상태](../moodcode/implementation-status.md) |
| 분석 방식 | `static-source-review`. 설치·빌드·테스트·모델·계정·API·GUI·실제 process 실행 없음. |

[증거 JSON](crush.evidence.json)은 읽은 구간의 whole-file/range SHA-256와 후보 계약을 가진다. 구간은 모두 160줄 이하이며 `git show`의 고정 commit 내용과 checkout bytes를 대조했다. 주요 기능 범주의 호출 경로를 나누어 28개 구간을 기록했다. 이는 실행 검증이나 upstream 테스트 통과 기록이 아니다.

## 대표 고정 근거

| ID | 확인 범위 | full-SHA permalink |
|---|---|---|
| R01 | 실제 Go 진입점 | [`main.go:15`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/main.go#L15-L26) |
| R03 | provider → LanguageModel | [`internal/agent/coordinator.go:968`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/agent/coordinator.go#L968-L1062) |
| R06 | Stream·step·RunComplete | [`internal/agent/agent.go:778`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/agent/agent.go#L778-L932) |
| R10 | 승인 | [`internal/permission/permission.go:158`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/permission/permission.go#L158-L278) |
| R11 | 명령·background | [`internal/agent/tools/bash.go:198`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/agent/tools/bash.go#L198-L343) |
| R13 | Task/Plan palette | [`internal/config/config.go:1067`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/config/config.go#L1067-L1138) |
| R17 | MCP transport | [`internal/agent/tools/mcp/init.go:1175`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/agent/tools/mcp/init.go#L1175-L1334) |
| R19 | SQLite | [`internal/db/connect.go:17`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/db/connect.go#L17-L171) |
| R20 | 반복 loop 중단 | [`internal/agent/loop_detection.go:11`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/internal/agent/loop_detection.go#L11-L92) |
| R25 | FSL·미래 MIT | [`LICENSE.md:1`](https://github.com/charmbracelet/crush/blob/140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5/LICENSE.md#L1-L134) |

## 진입점에서 종료까지

1. **진입과 host 구성 — 소스 확인.** `main.main()`이 `cmd.Execute()`를 호출한다(R01). TUI root command는 `internal/cmd/root.go:110`의 `setupWorkspaceWithProgressBar` 후 Bubble Tea를 시작한다. 로컬 구성은 `config.Init`, yolo override, `db.Connect`, skills discovery, `app.New`, `AppWorkspace`와 shutdown callback을 연결한다(R02). `CRUSH_CLIENT_SERVER`가 켜진 경로의 client/server와 로컬 app은 서로 다른 host 경로다. `crush run`은 별도 non-interactive 진입이며 질문 도구를 제외하고 해당 세션의 permission을 자동 승인한다(R28). 따라서 TUI의 일반 승인 동작을 모든 실행 모드에 일반화하지 않는다.
2. **agent와 모델 — 소스 확인/외부 경계.** coordinator는 Coder/Plan을 구성하고 현재 agent의 model/tool 설정을 갱신한다. `buildAgentModels`는 large/small config와 catalog metadata를 찾고 provider의 `LanguageModel(ctx, modelID)`에 위임한 뒤 요청 timeout wrapper를 붙인다(R03). `buildProvider`는 OpenAI/Anthropic/OpenRouter/Vercel/Azure/Bedrock/Google/Vertex/compatible 계열을 고른다. ChatGPT OAuth는 Codex endpoint를 선택하며 알려진 local/custom provider도 compatible builder로 연결된다(R21). 연결 코드가 있다는 사실과 계정별 동작은 구분한다.
3. **세션 dispatch — 소스 확인.** `sessionAgent.Run`의 세션 mutex가 accepted 취소, busy queue, active 등록을 한 경계에서 결정한다. cancel function은 assistant 생성 전에 등록한다. tool/model/system snapshot으로 `fantasy.NewAgent`를 생성한다(R05). `messageQueue`, accepted counter, cancel mark, active map은 process-local `csync` 자료구조다(R26).
4. **모델·도구 반복 — 소스 확인/외부 경계.** `agent.Stream`에 prompt·history·files·provider options와 callback을 넘긴다. `PrepareStep`은 최신 도구를 channel/disabled MCP 정책으로 필터링하고 큐의 후속 입력을 반영한 다음 assistant row와 tool context를 만든다(R06). tool call/result와 finish reason/usage는 callback에서 저장한다(R07). 실제 generation loop, 기본 종료 판단, tool 실행 스케줄·병렬성, retry 최대 횟수는 `fantasy` 구현 경계이므로 이 repository만으로 확정하지 않는다.
5. **완료·중단 — 소스 확인.** step의 `stop`, length, tool-use, content-filter를 영구 finish reason으로 바꾼다. 도구의 `StopTurn`도 end-turn으로 투영한다(R07). Run exit defer는 message flush 뒤 session/run/message/text/error/cancel 필드를 가진 `RunComplete`를 발행한다(R06). 자동 요약은 tools 없는 별도 agent로 수행하며 성공한 summary message의 ID와 session usage를 저장하고 큐를 이어간다(R08). shutdown은 agent 취소와 flush 후 shell/LSP 및 등록된 MCP·DB 정리를 호출한다(R23). 종료 이벤트는 cleanup 완료의 일반 증명과 동일하지 않다.

## 주요 기능과 조건

| 범주 | 고정 소스에서 확인한 동작 | 기본값·조건·한계 |
|---|---|---|
| 문맥·skill | 프로젝트/전역 경로의 파일 및 directory를 읽고 skill metadata를 discovery·dedup·disabled filter한다(R09). tool 결과를 대응 assistant 바로 뒤로 재배치하고 orphan result를 제외한다(R22). | prompt build에서 읽는 context와 요청 이력 projection이다. 별도 repository embedding index·프로젝트 간 자동 학습 기억은 검사 경로에서 확인하지 못했다. skill 본문 읽기 도구는 R04의 View 연결이며 metadata 전체를 그대로 본문으로 넣는 것은 아니다. |
| 요약·기억 | context-window 잔량으로 stop하고 summary message·`SummaryMessageID`를 남긴다(R07/R08). | unknown context window `0`은 auto-summary를 건너뛴다. `DisableAutoSummarize`가 동작을 끈다. summary와 session pointer는 순차 저장이며 원자적 활성화·crash 복구를 이번 근거로 보장하지 않는다. |
| 검색·읽기 | glob/grep/ls/view/Sourcegraph가 agent palette에 등록된다(R04). LSP symbol은 문서의 계층·종류·이름·줄 위치를 얻는다(R27). | 파일 검색·외부 코드 검색·LSP lookup은 다른 경로다. remote Sourcegraph 가용성·semantic retrieval 품질은 미검증이다. |
| 편집·검증 | edit/multiedit/write 및 LSP rename/replace 도구가 있다(R04). 기존 파일은 읽기 이력 timestamp와 수정 시간으로 stale를 검사하고 diff의 전후 내용을 permission에 보내 변경한다(R15). | 편집 helper 호출은 whitespace correction 여부를 반환한다. 이 timestamp 검사와 directory/action 승인은 Moodcode의 exact hash/fingerprint 승인과 다른 계약이다. 승인 대기 중 파일을 다시 읽어 같은 hash를 확인하는 보장은 선택한 replacement 경로에서 확인하지 못했다. LSP diagnostics/명령 실행이 검증 수단이며 성공 테스트를 필수 완료 gate로 요구한다고 주장하지 않는다. |
| 승인 | pending request, session/tool/action/path grant, allowlist, hook allow, session auto-approval을 지원한다(R10). | `GrantPersistent`는 이 서비스의 session map에 저장하는 grant다. DB-backed 영구 grant로 해석하지 않는다. yolo는 설정 override(R02), non-interactive는 session auto-approval(R28)이다. |
| 명령·background | 명령은 permission 후 shell manager를 통해 실행하며 명시적 background 또는 기본 60초 auto-background를 지원한다(R11; 상수는 같은 파일 54행). job output/kill 도구가 등록된다(R04). | detached `context.Background()`를 사용한다. foreground 대기 중 cancel은 kill하지만 background 승격 후 turn cancel과 수명이 분리된다. job manager의 전체 process 소유권·재시작 replay를 보증하지 않는다. |
| 취소·소유권 | 세션의 accepted/queued/active 전환을 동기화한다(R05/R26). Unix 외부 process는 `Setsid`, 음수 PID signal, `Wait`를 쓴다(R12). 종료 시 background manager를 정리한다(R23). | 부모 강제 종료, group을 떠난 daemon, signal 오류/PID 재사용, Windows tree cleanup에 대한 실제 종료 증거는 미검증이다. Unix cancellation 코드를 Moodcode supervisor의 crash ownership 증명과 동등하게 취급하지 않는다. |
| 저장·재개·queue | SQLite WAL·NORMAL synchronous, 단일 connection과 migrations/pool이 있다(R19). 메시지/summary/session을 callback으로 저장하고 종료 flush를 호출한다(R06/R07/R08). | data-directory lock은 opt-in이고 로컬 기본은 off다(R19). 같은 세션 실행 큐는 메모리 map(R26). 대화 재개·client reconnect와 미완료 tool effect의 안전한 replay/복구는 다른 기능이다. 검사 경로에서 durable queue·effect intent/receipt frontier·원래 PID owner 검증을 확인하지 못했다. |
| 하위 agent·profiles | Task/Plan의 tool allowlist를 구성하고 Task는 별도 child session에서 같은 context로 Run한다. 결과는 parent tool response text, child 비용은 best-effort 합산이다(R13/R14). | Task는 read-only 검색/LSP navigation이며 Task/Plan의 기본 MCP allowlist는 빈 map이다. 코드의 read-only LSP 도구 포함을 따른다; 같은 구간의 “NO … LSPs” 주석만으로 LSP 부재를 결론내리지 않는다. worktree 격리·write child 통합·영구 team mailbox·명시적 child budget 상속은 이 경로에서 확인되지 않았다. |
| LSP | diagnostics/references/restart/symbols/definition/call hierarchy/rename/replace-symbol이 연결된다(R04/R27). | 설정 LSP가 있거나 `AutoLSP`가 nil/true일 때 도구를 등록한다. server executable·언어별 지원은 미실행이다. |
| MCP·channel | stdio/HTTP/SSE, OAuth transport를 SDK에 연결한다(R17). 도구는 channel scope와 일반 permission을 검사하며 일부 Docker 도구는 whitelist로 prompt를 생략한다(R18). 단계 경계에 최신 도구를 선택한다(R06). | catalog/resource 도구도 등록된다(R04). SDK network behavior·remote 효과 rollback/확정·동적 변경의 실제 성공은 미검증이다. channel별 RPC routing을 다자 agent mailbox로 해석하지 않는다. |
| hook | top-level `PreToolUse`는 deny/halt·입력 변경·allow에 의한 pre-approval·결과 context 추가가 가능하다(R16/R10). | child 내부 도구는 hook interception을 생략한다. hook 오류는 원 도구 호출을 계속하는 경로가 있다. 전체 lifecycle/plugin 생태계나 timeout 뒤 process 종료를 인증하지 않는다. Moodcode 후보는 기존 승인 binding을 보존하는 별도 계약이다. |
| provider·media | 사용자 attachments와 tool 결과의 file/image/media를 fantasy에 전달하고 모델의 `SupportsImages`로 필터링한다(R22/R18). provider별 model metadata와 builder가 있다(R03/R21). | image 지원 boolean과 audio/video/PDF별 token/capability·history 정책은 같은 개념이 아니다. 여러 media가 들어온 실제 모델 응답·미디어 생성·정확한 MIME/token 예산은 미검증이다. |
| loop 중단 | 최근 10 step의 tool 이름·입력·결과 signature에서 동일 값이 5회 초과하면 stop한다(R20/R07). | 전체 Run max-turn/예산 계약을 대신하는 것은 아니다. 같은 입력이어도 결과가 바뀌면 signature가 달라지고, 10 step 미만에서는 이 감지가 작동하지 않는다. |

**README 주장:** multi-model, session 유지, LSP/MCP, 여러 OS와 terminal 지원은 README(R24)의 주장이다. R03/R04/R17/R21은 구성 경로의 존재를 뒷받침하지만 모델·서비스·OS별 성공을 입증하지 않는다. **분석 추론:** Crush의 핵심 orchestration은 app/세션 서비스와 external fantasy 사이의 callback 기반 분업으로 볼 수 있다. 이 평가는 코드 구조에서 도출한 설명이며 성능·보안·품질 순위가 아니다.

## Moodcode 독립 구현 후보

비교 소스에서 기존 `lsp/index.ts`의 diagnostics/formatting·hash/version, `runner/index.ts:919`의 반복 읽기 차단과 effect 뒤 reset, `tools/command/index.ts`의 exact 승인/supervisor, `terminals/service.ts`의 host 소유 PTY/journal, `plugins/index.ts`의 prepared/settled 관측 hook을 확인했다. 다음은 기존 구현의 추가 계약이며 구현 착수나 완료 선언이 아니다. 비용 M/L은 상대적인 후속 설계·구현·검증 범위다.

| 후보 | 기존 Moodcode와 차이 | 독립 계약·관련 경로 | 검증 조건 | 우선순위·비용 |
|---|---|---|---|---|
| CR-C01: 문서 버전 LSP navigation | LSP/formatter는 이미 있다. Crush의 symbol/definition/hierarchy 읽기 palette를 참고한다(R04/R13/R27). | `lsp/index.ts`, `lsp/stdio.ts`, `tools/runtime/index.ts`, `engine.ts`: 명시적 host factory에서 capability·문서 hash/version·workspace URI·count/bytes/depth/deadline에 묶인 navigation 조회. 쓰기 rename은 별도 승인 계약으로 남긴다. | unsupported capability·stale 문서·외부 URI·과대 hierarchy·cancel을 구분하고 root/read-only child의 같은 capture/context를 유지. | P1·M |
| CR-C02: 무진전 상호작용 중단 | 반복 읽기 차단·Run 예산은 이미 있다. 입력뿐 아니라 결과가 동일한 비진전 cycle을 관측한다(R07/R20). | `runner/index.ts`, `runner/turn-executor.ts`, `tools/runtime/index.ts`, `storage/native-records.ts`: prepared identity·결과 digest·effect epoch의 bounded window와 typed stalled 종료 증거. | 변경 결과·paging 진전·새 checkpoint는 허용하며 동일 실패 cycle만 중단; terminal 한 번·기존 repeat-read 회귀 보존. | P2·M |
| CR-C03: session command job | command supervisor·PTY·journal·cleanup 격리는 이미 있다. 모델 command의 handle 조회 경험만 확장한다(R11/R12/R23). | `tools/command/index.ts`, `tools/command/supervisor.ts`, `terminals/service.ts`, `terminals/journal.ts`, `storage/execution-uncertainty.ts`: 승인 preview의 명시적 background 옵션, session/workspace/native owner와 수명·output cursor·lease에 묶인 job. | 무승인 background 승격 거절, session 간 권한 분리, 살아 있는 job과 쓰기/restore 경합 제한, crash/PID 재사용/late output/unknown cleanup 격리. | P2·L |
| CR-C04: host 정책 hook | metadata prepared/settled hook은 이미 있다. effect를 차단하는 정책 gate만 추가한다(R10/R16/R23). | `plugins/index.ts`, `runner/index.ts`, `tools/command/supervisor.ts`, `storage/tool-recovery-frontier.ts`: host 등록의 versioned observe/deny/halt; allow는 exact 승인 우회 금지. 입력 변경은 prepare 전 새 binding 필요. 외부 hook은 owner/deadline/output/cleanup receipt 필수. | deny/halt의 effect 전 기록, malformed/allow 우회 방지, timeout/cancel/late 응답·cleanup 불확실성 격리, child 상속 정책·비밀 비노출. | P2·M |

전체 `moodcodePaths`와 contract/validation의 상세 명세는 증거 JSON의 동일 후보 ID를 따른다. upstream의 자동 승인·단순 timestamp 편집 검사·background context 분리를 Moodcode의 exact approval/cleanup 규칙으로 복제하지 않는다.

## 라이선스와 출처

root `LICENSE.md`는 **FSL-1.1-MIT source-available**이다(R25). 현재 grant의 Permitted Purpose는 Competing Use를 제외한다. competing use는 소프트웨어를 대체하거나 같은/실질적으로 유사한 기능의 상용 제품·서비스로 타인에게 제공하는 경우를 포함한다. 재배포·파생물에는 조건과 copyright 고지를 유지하도록 적혀 있다. 각 software version을 공개한 날의 **두 번째 주년**부터 추가 MIT license가 효력을 갖는 구조이며, 고정 HEAD 전체가 지금 일반 MIT OSS라는 의미가 아니다. commit 일시를 최초 공개일로 간주해 전환일을 임의 확정하지 않았다.

같은 파일의 하단에는 `2025-03-21–2025-05-30 Kujtim Hoxha`의 별도 MIT 고지도 있다. 이를 root의 현재 FSL 제한을 제거하는 전면 MIT 분류로 사용하지 않는다. checkout 파일명 검사에서 root `LICENSE.md`를 확인했으나 dependency/서비스/브랜드/재배포 묶음 전체를 감사한 것은 아니다.

이번 변경은 동작 설명·출처·Moodcode 독립 계약만 포함한다. 원본 코드, prompt, tool description, fixture, media를 복사하거나 upstream runtime을 Moodcode 의존성으로 추가하지 않았다. 원본을 읽은 분석이므로 clean-room 절차를 수행했다고 주장하지 않는다. 라이선스의 법률 검토·경쟁 용도 적용 판단은 별도다.

## 확인 한계

- 실제 dependency source·provider wire behavior·기본 loop 종료/병렬 tool 실행·retry 횟수는 외부 boundary다. 공개 checkout에 연결 코드가 있다는 사실만 확인했다.
- 실행 중 queue/approval/job의 process-local 상태와 SQLite 대화의 지속성은 구분했다. 재시작 후 외부 effect의 확정·안전한 재실행·완전한 복원 계약은 이 검토에서 인증하지 않았다.
- 저장소 전체에 특정 제품 기능이 없다고 단정하지 않는다. 검사한 main path에 없거나 불완전한 증거는 확인하지 못한 범위로 남긴다. OS/provider/model/skill/MCP 서버별 capability·계정·서비스 가용성·실제 media 동작도 미검증이다.
- 증거 bytes/줄 번호/HEAD 대조만 정적으로 검증했다. Moodcode의 기존 테스트 통과 기록과 upstream 실행 결과를 섞지 않았으며 이번 요청에서는 어느 쪽의 새 runtime 테스트도 수행하지 않았다.
