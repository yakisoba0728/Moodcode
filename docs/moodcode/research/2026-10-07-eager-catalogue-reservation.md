# 기본 eager catalogue와 문맥 예약의 불일치

2026-10-07. G1-29 구현 전 `93bfeaa`의 실제 로컬 엔진 비교다. 기존 eager 모드에서 execute 초기에 계산한 예약량이 async context build 뒤와 다음 turn에도 남고, provider 직전에는 catalogue만 새로 만드는 경로를 확인했다. G1-29는 [1차의 마지막 필수 수정](../engine-phase-one-exit-criteria.md)이다.

## 같은 조건의 대조군

각 조건은 임시 MoodcodeEngine/SQLite·실제 ContextService·기본 core21·완료된 이전 user text16,414B·무효과 plugin schema8,269B·합성 provider를 사용했다. 첫 context build의 await 안에서 plugin을 추가한다. Semantic summary source cap1,024B로 provider 호출 전 거절되고 기존 extractive fallback을 사용한다. 원문 이력은 그대로 유지한다.

두 대조군은 같은 훅에서 request의 예약량만 최신값으로 보정하거나, target Run 시작 전에 plugin을 등록해 기존 eager 생산 경로를 그대로 사용한다. 예약은10,158→18,524B이며 어느 조건도 handler를 실행하지 않는다.

| 32KiB byte cap 조건 | 계획 bytes | 최신 tools 포함 실제 envelope | target provider | 결과 |
|---|---:|---:|---:|---|
| 기존 async growth | 28,146 | 36,512 | 0 | CONTEXT_LIMIT |
| 최신 reservation 보정 | 21,629 | 21,629 | 1 | completed |
| target 전 사전등록 | 21,629 | 21,629 | 1 | completed |

최종 byte gate는 상한을 안전하게 지킨다. 그러나 최신 예약으로 optional 이력을 하나 생략한 합법적인 대조군이 완료하므로 필수 문맥이 본질적으로 너무 큰 사례가 아니다. Stale planning으로 발생한 불필요한 실행 실패다. 실패군의 target Turn/Attempt/cleanup은0이다.

## 알려진 모델 window의 별도 비교

같은 fixture에서 config byte cap65,536, host가 명시한 conservative model window32,768, output reservation1,024를 사용했다. 기존 계획의 UTF-8 상한 추정28,146+1,024=29,170은 window를 통과했지만 실제 전송 envelope36,512+1,024=37,536은 그 계획 기준을 넘었고 local target provider1회로 completed였다. Final byte gate의65,536B는 넘지 않는다.

최신 예약 보정과 자연 사전등록 대조군은 각21,629+1,024=22,653으로 완료했다. 이는 엔진이 사용하는 보수적 추정과 선언한 window의 일관성 문제다. 실제 tokenizer의 토큰 수나 원격 모델의 거절을 측정한 것이 아니다.

두 실험은 각각 source3조건·private bundle3조건·scoped noEmit을 통과했다. Whole snapshot·summary provider·handler·외부 계정·프로젝트 DB·recovery ACK·저장소 소스 변경은0이다. 최초 결과와 최종 source/log SHA는 [기계 판독 결과](../engine-goal-verification.json)의 nextLocalCandidate에 보존한다. 이6조건을 최신 whole gate 테스트 수에 더하지 않는다.

## 마지막 수정의 경계

Eager도 같은 immutable catalogue로 reservation→context plan→final check→provider schemas→handler resolve를 연결한다. Normal turn/steer 경계와 async build 이후의 registry/policy 변경은 제한된 재계획으로 처리한다. 매 catalogue 호출이 새 object를 반환하므로 reference equality만으로 변경을 판단하지 않는다. 빈 catalogue도 opaque capture/current 검사를 요구한다.

같은 logical Turn의 HTTP/overflow retry는 원래 advertised schemas와 handler capture를 고정한다. Recovery 중 source가 바뀌면 새 capture로 원래 요청을 바꾸지 않고 stale로 재시도 전에 중단한다. 기존 scoped approval·Run allowlist·native 저장·cleanup·context CAS와 runtime 없는 Coordinator 호환을 유지한다. 수정 완료 후 전체 gate와 동일 source의 제한된 실제 모델 회귀를 다시 실행한다.
