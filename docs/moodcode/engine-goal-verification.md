# 엔진 1차 최종 검증 — 열일곱 번째 검토 지점

최종 구현 커밋은 `464812f7d1af24466f57070663131f5979aeca51`다. macOS arm64 / Node26.9.0에서 G1-29의 기본 eager catalogue와 문맥 예약을 동기화했다. G1-01~29 구현·검증을 마쳤으며 [1차 종료 조건](engine-phase-one-exit-criteria.md)에 따라 문서 커밋·clean tree 확인 뒤 goal을 완료 처리한다. 추가 G1-30 구현과 GUI 작업은 시작하지 않는다.

## 최종 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency4 | 2,596개 중2,594 pass, 실패0·취소0·기존 OS 조건부2 skip; 65,766.9ms |
| fixture 코딩 평가 | 3/3 |
| 실제 ContextService 예산 source / private bundle | 각각8/8 |
| 실제 engine 경계 source / private bundle | 각각10/10 |
| 독립 runtime/Coordinator source / private bundle | 각각23/23 |
| 세 담당 범위 scoped noEmit | 모두 통과 |
| 기존 Attempt/cleanup/retry/Coordinator source | 177/177 |
| 기존 G1-27/G1-28 실제 경계 source | 29/29 |
| 기존 output budget source / compiled | 각각4/4; source는 resolved absolute tsx loader 사용 |
| 같은 source 실제 Codex child text | default eager 1회 통과; root/PDF/외부 MCP 계정 요청0 |

새 테스트는41개다. 집중 검사·구현 전 대조군을 전체 테스트 수에 더하지 않는다. 원래 whole manifest와 기존 skip 조건을 유지했다. 최종 source175개 pin, 세 담당 source/dependency·bundle graph, command/log/SHA와 최초 실패의 분류는 [기계 판독 결과](engine-goal-verification.json)에 고정했다. 모든 source pin은 final source commit의 bytes와 같다.

## 마지막 필수 수정

기본 eager도 같은 opaque catalogue를 예약·ContextPlan·최종 byte 검사·provider schemas·handler resolve에 사용한다. 현재 capture의 exact signature·registry revision·policy version이 같으면 같은 handle을 재사용한다. Async build 이후와 normal turn/steer 경계에서 변경이 확인되면 최신 예약으로 제한된 재계획을 수행한다. Context·dispatch·steer 재계획은 각각16회 상한이며 지속 변경은 typed stale로 종료한다. Core21·현재 profile/Run allowlist/승인과 원문 이력을 유지한다.

Eager/discovery 양쪽의 `context.prepared`에 실제 reservedToolBytes·tools array SHA·advertisedToolNames를 기록하고 runtime capture가 있으면 revision/policyVersion도 기록한다. DB9/metrics6과 기존 metrics context의 네 필드는 유지한다. 알려진 model window의 보수적 추정과 final configured byte cap을 같은 예약으로 검사하며 실제 tokenizer나 원격 모델 수락을 보장하지 않는다.

동일 logical Turn의 HTTP retry는 원래 schemas/messages를 사용한다. 각 Attempt에 detached 요청을 만들어 adapter의 nested mutation이 다음 retry·host schema·원래 logical request SHA를 바꾸지 못하게 했다. Overflow recovery는 original catalogue를 고정하고 source 변경 시 eager의 TOOL_CATALOGUE_STALE 또는 discovery의 TOOL_DISCOVERY_STALE로 다음 Attempt 전에 중단한다. Empty catalogue의 current guard와 runtime 없는 trusted Coordinator의 static allowlist/opaque handler 호환도 검증했다. [계약](engine-eager-catalogue-context.md), [구현 전후 조사](research/2026-10-07-eager-catalogue-reservation.md)를 따른다.

실제 ContextService의 byte cap·known conservative window·async growth/policy·다음 logical turn·steer cutoff·취소·16회 변경·본질적인 mandatory token overflow를 확인했다. 같은 예약·실제 요청·계획·감사 event의 hash/names가 일치하고 summary provider/whole snapshot/plugin handler 호출은0이다. HTTP503 retry·adapter mutation·original cleanup SHA·overflow stale도 실제 TurnExecutor/임시 SQLite로 확인했다. 합성 provider 검사이며 원격 도구 효과 검증으로 확대하지 않는다.

## 초기 실패와 수정 구분

기존 `93bfeaa`에서 source/private bundle6조건으로 옛 예약10,158B와 성장 뒤18,524B의 불일치를 확인했다. 32KiB cap의 stale plan28,146B는 실제36,512B로 provider 전 CONTEXT_LIMIT이지만 최신 예약 보정/사전등록 대조군은21,629B로 완료했다. Known window32,768/outputreserve1,024·config65,536에서는 stale plan29,170이 통과한 뒤 actual estimate37,536을 전송했다. Actual tokenizer·원격 모델의 거절은 측정하지 않았다. 원래 대조군은 역사 증거로 보존했다.

추가로 기존 TurnExecutor의 같은 Turn retry를 실제 source1개로 재현했다. 첫 adapter가 tools/messages를 변경한 뒤 pre-output429로 실패하면 다음 retry가 변경된 요청을 받았다. 각 Attempt deep clone 뒤 source/private bundle 회귀가 통과했다. 첫 RED 때 fixture SHA를 고정하지 못한 한계도 JSON에 기록했으며 이후 최종 파일 SHA와 최초 로그를 보존했다.

작성 중 누락된 createHash import는 수정했다. 첫 whole 시도는 새 합성 generator의 추론된 optional undefined JSON 타입 때문에 compile에서 종료돼 whole tests가 실행되지 않았다. Fixture의 explicit AsyncGenerator<ProviderEvent> 타입으로 수정했다. 두 번째 whole은2,593 pass·1 fail·2 skip이었다. 기존 exact output-budget event assertion에 새 감사 필드를 추가하고 실제 byte/summary/output 검사와 metrics의 원래 네 필드 검사를 유지한 뒤 최종 whole을 통과했다.

Source-only output-budget 검사에서 bare `--import tsx`가 임시 command cwd에서 resolve되지 않는 조건을 별도 진단했다. 같은 command 검사·assertion은 compiled와 resolved absolute loader source에서4/4 통과했다. Command 생산 코드나 skip을 바꾸지 않았다. 담당 fixture의 memoization/API/typing 수정과 실제 생산 결함은 별도로 기록했다.

## 실제 모델과 저장 회귀

기존 로컬 Codex 인증의 gpt-6.1-sol child text1회가 natural confirmed cleanup으로 완료됐다. 도구0개·default eager reservation24B와 실제 tools-array SHA를 확인했다. Input266/output5·cached/reasoning0·billed=null이다. Logical request1,746B이며 raw HTTP SHA가 아니다. 실제 자율 코딩·원격 PDF·MCP 호출은 이번 최종 live의 범위 밖이다.

Host-only PDF54B, historical metadata10,456B/refs1/rows28/child1/raw mirror491,520B/elapsed8.1ms를 관측했다. Archive/validate·historical inspection·import child pause1·restored authority 없음·typed reexport 거절·임시 fixture 제거가 통과했다. Whole snapshot0·프로젝트 recovery ACK0이다. 표본 elapsed/bytes를 처리량이나 물리 I/O 상한으로 확대하지 않는다.

## 보존과 인계

[열여섯 번째 JSON](engine-goal-sixteenth-verification.json)은 `019a2ea`의 원본 bytes 그대로 보존했다. SHA는 `dcd234cc4f6d5e2605d726ea4653a615165a6e18d07c697684fcb36aeb5aca76`다. 기존 MCP/native frontier·prepared 권한·승인/ACK·원본 journal·저장/archive 계약은 유지한다. 세 담당 작업은 최종 파일·manifest를 동결하고 종료했다.

1차의 남은 로컬 구현은 없다. 최종 문서와 TODO를 함께 커밋하고 source pins·상대 링크·원래75항목의71완료/4미완료·clean tree를 확인한 뒤 goal의 상태를 complete로 전환한다. 검증 JSON의 goalStatusAtVerification=active는 마지막 전환 전 관측 시점이다. 도구가 활성 objective 문구 편집을 지원하지 않아 앱의 옛 문구는 그대로지만, 실제 종료 판단은 사용자가 수정한 [1차 목표](engine-phase-one-exit-criteria.md)를 따른다.

Electron GUI 연결/UX/E2E와 E5-08 Windows backend, E5-13 다른 provider/실제 multimodal 계정, E6-07 hosted CI/OS, E6-08 지원 명세 확정은2차로 이월한다. 원래 열린 네 항목을 완료로 표시하지 않았다. 추가 기능·원격 PDF/token 계산·provider-native search와 미측정 성능 보장은 이 최종 검증에 포함되지 않는다.
