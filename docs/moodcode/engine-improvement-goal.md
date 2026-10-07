# 메인 엔진 지속 개선 목표

2026-10-07 사용자가 잠든 동안에도 goal을 활성화해 자체 엔진의 구현·수정·최적화·검증을 계속하도록 요청했다. 실제 진행 상태는 루트 `TODO.md`의 G1 항목과 검증 보고서를 기준으로 한다. GUI는 실행하지 않는다. 기존 로컬 Codex 인증을 사용하는 검증은 임시 저장소와 제한된 fixture 작업만 대상으로 한다.

## 비교 근거와 구현 방향

| 대상 | 확인 범위 | Moodcode에 반영할 문제 |
| --- | --- | --- |
| OpenCode | 공개 엔진 소스 `4ac0d9c3d169bbe81d9570013effdda3fe24d36e` | 긴 실행의 이력 선택·도구 결과 축소·provider 동작 |
| pi | canonical 공개 저장소 `ae92585d3b3e5f1e4b123d14a34314d826d8d9f5` | 초기 목표와 완전한 최근 exchange 보존·확장 경계 |
| Amp | 공식 models/subagents·plugin 문서 | 별도 child 문맥과 제한된 최종 결과 |
| Claude Code | 공식 sub-agents 문서 | 역할별 도구 허용목록·worktree·부모/child 수명 |
| Codex | 공개 Rust 엔진 `0b863c69f50335acd92164aab971cb58d298c2fe`와 공식 문서 | 사용자 anchor·미디어 보존·shared budget·사용량 관측 |

공개 소스에서 관찰한 문제와 동작을 기준으로 독립 계약·구현·fixture를 만든다. 원본 구현, 프롬프트, 도구 설명, 테스트를 복사하거나 비공개 실행 파일의 내부 엔진을 추정하지 않는다. [이력 조사](research/2026-10-07-context.md), [위임 조사](research/2026-10-07-delegation.md), [미디어 조사](research/2026-10-07-media.md), [Codex 비교](research/2026-10-07-codex.md)를 따른다.

## 반복 작업 단위

첫 단위는 bounded 이미지 입력, 승인된 읽기 전용 모델 위임, active Run 이력 선택, durable attempt 사용량이다. 담당자가 자체 테스트를 수행하고 다른 담당자가 실제 엔진 연결을 독립 검토한다. 통합 문제를 수정한 뒤 전체 headless gate, fixture 평가, 제한된 실제 Codex 과업을 실행하고 로컬 커밋으로 검토 지점을 남긴다.

후속 단위는 명시적인 이미지 이력 보존/생략 정책, 디스크 사용·orphan 진단, 복합 child/도구 실제 모델 과업, 실패·재시작·cleanup 경계와 필요한 최적화다. 누락된 usage를 0으로 만들거나 미확인 effect를 성공으로 간주하지 않는다. 성능 숫자는 측정 조건과 표본을 함께 기록한다.

Windows native Job backend, 다른 OS 호스트, 최초 hosted CI, 실제 Anthropic 계정 검증은 해당 환경이나 계정이 없으면 완료 처리하지 않는다. Git remote는 현재 없다. 새 외부 연결·발행·유료 서비스 설정은 임의로 만들지 않는다. 이 제한이 있어도 진행 가능한 로컬 엔진 작업은 계속한다.

## 두 번째 검토 지점

`59d1f42`에서 bounded storage host 진단·원본을 보존하는 이미지 이력 opt-in·반복 요청/승인/child 결과 SQL 조회·장수 instruction cache를 연결했다. 전체 1,713 pass·실패 0, fixture 3/3, 같은 커밋의 실제 Codex image history 2회가 성공했다. 이 시점의 후속 G1-09b active-prefix semantic checkpoint는 아래 세 번째 검토 지점에서 구현·검증했다. 이미지 픽셀 생략과 active-prefix 의미 요약의 근거를 각각 유지한다.

## 세 번째 검토 지점

`04031cb`에서 G1-09b의 exact active Run text/tool observations·whole exchange chunk·protected holes·두 문서/revision 원자 activation을 연결했다. 일반 의미 요약의 준비 시점 CAS, 관측 delta의 공유 출력 회계, 요약 중 steer가 도착할 때의 제한된 재계획, underlying iterator cleanup이 없는 retry 거부와 최신 active image SQL anchor도 수정했다. 전체 1,775 pass·실패 0, fixture 3/3, 실제 Codex summary 1회와 최종 답변 1회가 도구 원문이 빠진 임의 값을 기억에서 정확히 회수했다. 20번 읽기는 fixture-directed이며 모델의 자율 코딩 전략 검증으로 확대하지 않는다.

이 시점에 남겼던 G1-13/14는 아래 네 번째 검토 지점에서 구현했다. 실제 다른 provider/OS/hosted CI와 GUI 노출은 해당 환경이 준비됐다고 간주하지 않는다.

## 네 번째 검토 지점

`ede1519`에서 DB4 summary lifecycle·최신 nullable usage·원자 publication, 부분 출력·cancel/close·세 단계 실제 crash·archive를 연결했다. session-wide 최신 image SQL anchor·semantic cutoff 복원과 실제 text Run의 pixel 전송을 확인했다. 독립 리뷰의 image wrapper cleanup 오인, return.done=false retry, orphan summary 뒤 maintenance-first·다른 session resume 경계도 수정했다. 전체 1,848 pass·실패 0·Windows 조건 2 skip, 코딩 fixture 3/3이다. 실제 Codex summary+answer 2회와 image+재시작 text Run 2회가 같은 커밋에서 성공했다. [네 번째 기계 판독 결과](engine-goal-fourth-verification.json)를 따른다.

이 시점의 G1-15/16은 아래 다섯 번째 검토 지점에서 구현했다. 원래 미확인 요청을 자동으로 재실행·활성화하거나 cleanup 성공으로 바꾸지 않는다.

## 다섯 번째 검토 지점

`29b59a1`에서 DB5의 명시적 host 복구 결정·정확한 owner/source/revision/fingerprint·physical store binding과 전용 lease를 연결했다. 실제 COMMIT 전후 SIGKILL·journal rollback·archive/import·다른 실행 격리·context head 변화·exact decision retry를 검증했다. 결정은 원래 uncertainty와 durable queue/control을 보존하며 명시적 새 실행만 이어갈 수 있다. 사용자가 잠든 동안 프로젝트의 실제 unresolved 기록을 대신 승인하지 않는다.

동일한 1k/10k typed fixture와 64KiB 부분 출력에서 이전 class의 usage 조회 67,849 bytes를 2,378 bytes로 줄였고 중복 usage/progress write는 1→0이다. 실제 partial index 조회와 선택 증거 한도를 확인했다. 물리 I/O나 반복 처리량 보장으로 표시하지 않는다. 전체 gate는 동시성 2의 같은 목록에서 1,894 pass·실패 0·Windows 조건 2 skip, fixture 3/3이다. 커밋 후 실제 Codex summary+answer 2회와 임시 uncertainty 결정 뒤 새 Run 1회가 성공했다. 이전 두 fixture 실패와 원인 미확정 exit 137도 [다섯 번째 근거](engine-goal-fifth-verification.json)에 기록했다.

이 시점의 G1-17은 아래 여섯 번째 검토 지점에서 구현했다. 기존 상태에서 cleanup을 추정해 backfill하지 않는다. 외부 OS/provider/CI 한계와 GUI 제외를 유지하면서 goal을 계속 진행한다.

## 여섯 번째 검토 지점

`11da986`에서 DB6 ordinary Attempt 종료 관측·logical request SHA/context·별도 outcome·native/v1 원자 journal을 연결했다. consumer close·출력/protocol/저장 실패·타이머 경합·재시작 격리·archive/migration/no-backfill을 검증했다. exact failed overflow와 unknown summary만 결합하고 독립 ordinary uncertainty는 차단한다. summary 사용량/uncertain 저장 뒤 Turn 연결 전의 실제 SIGKILL 두 경계와 strict boolean done도 독립 리뷰 뒤 수정했다. [종료 수명 비교](research/2026-10-07-cleanup.md)와 [자체 계약](engine-attempt-cleanup.md)을 따른다.

전체 같은 목록의 동시성 2 gate는 1,966 pass·실패 0·조건부 2 skip, fixture 3/3이다. 실제 Codex 새 Run 1회에서 logical SHA·종료 proof·head 변화/재시작 보존을 확인했고 active-prefix 요약/답변 2회도 통과했다. unknown 원격 서버 상태나 과금은 검증하지 않았다. synthetic 1k/10k ordinary 행의 execution predicate는 clear 199 bytes·5 queries, 첫 unknown 204 bytes·2 queries로 같았다. Turn payload와 각 ACK/source 한도는 별도이며 전체 합산·물리 I/O·처리량 상한으로 표시하지 않는다.

이 시점의 G1-18은 아래 일곱 번째 검토 지점에서 구현했다. [여섯 번째 근거](engine-goal-sixth-verification.json)를 보존한다. 프로젝트의 실제 unresolved 기록을 대신 승인하거나 원래 실행을 자동 재시도하지 않는다.


## 일곱 번째 검토 지점

`5d70a22`에서 DB7 일반 provider 결과 복구 결정과 summary pin proof V2를 연결했다. confirmed cleanup과 정확한 uncertain dispatch·logical request·원래 입력·부분 출력·도구 관측·context source/pins를 별도 ledger에 결합한다. 완성된 도구 제안은 provider 완료 전에도 저장하며 효과는 finish 검증 뒤에만 실행한다. 정상 취소의 확정 interrupted 호출은 결정 대상이 아니다. 실제 SIGKILL 세 경계·원자 audit rollback·물리 archive/import·다른 후보·queue/control 보존을 검증했다.

독립 리뷰에서 generic tool metadata의 오인, missing native source 및 이전 summary 참조 누락, summary pin 제거와 baseline-only owner drift를 수정했다. 기존 V1 summary 결정은 원래 body/scope와 exact 역사 retry를 보존하되 새 실행 허용 근거로 사용하지 않는다. 새 V2 결정은 명시적인 host 요청이 필요하며 실제 프로젝트 기록에 대신 결정하지 않는다. [provider 계약](engine-provider-recovery.md), [summary 호환·참조](engine-summary-recovery.md)를 따른다.

전체 동시성 2 gate는 2,055 pass·실패 0·조건부 2 skip, 집중 174/174, 코딩 fixture 3/3이다. 같은 source commit에서 실제 Codex ordinary 복구 뒤 새 Run 1회, overflow summary 복구 뒤 새 Run 1회, active-prefix 요약/답변 2회가 통과했다. 원래 unknown outcome/usage·부분 제안·control/context 보존과 head 변화/재시작·logical request SHA를 확인했다. 실제 원격 uncertainty·서버 중지·과금은 확인하지 않았다. 실패하거나 live cleanup proof가 없으면 검증용 임시 DB를 보존한다.

이 시점의 G1-19 공유 조회 예산은 아래 여덟 번째 검토 지점에서 구현했다. [일곱 번째 근거](engine-goal-seventh-verification.json)를 그대로 보존하고 원래 열린 외부 OS/provider/CI 4개와 GUI 제외를 유지한다.


## 여덟 번째 검토 지점

`42218a8`에서 G1-19의 workspace 통합 검사와 한 transaction의 8MiB 선택 본문 예산·4,096개 raw cache를 연결했다. summary/provider/Turn·cleanup/native owner와 ACK의 두 CAS가 범위를 공유한다. 원문 문자열만 재사용하고 owner/source/pin/fingerprint를 다시 검증한다. write/rollback/외부 변화 때 cache를 폐기하며 이미 선택한 bytes는 환급하지 않는다. 일반 getter와 custom store fallback을 유지한다. [공유 조회 계약](engine-recovery-evidence-read.md)을 따른다.

독립 검토에서 header 이후 callback이 owner를 키워 큰 본문이 반환되던 경계를 발견해 SQL body length 조건으로 차단했다. 실제 9MiB owner 변경의 원문·양 journal rollback과 반환 0B를 확인했다. 숫자 9→10을 문자열 CAST 별칭으로 정렬하던 결함도 수정했다. 기존 V1 digest encoding을 별도로 유지해 valid ACK·정확한 역사 receipt를 보존한다.

이전 `5d70a22` 전체 engine/contracts의 독립 bundle과 같은 실제 private mixed fixture를 비교했다. raw 본문 211,983→83,173B, SQL 값 249,210→121,980B로 줄었고 mutation/owner 검사 때문에 query는 296→368로 늘었다. 각 domain 1.69MB/7.21MB는 통과하지만 distinct union 8.90MB는 공통 예산에서 차단하고 초과 Part 본문은 읽지 않았다. 물리 I/O·SQLite 내부 작업·production latency/throughput의 보장으로 표시하지 않는다.

전체 gate는 2,087 pass·실패 0·조건부 2 skip, coding fixture 3/3이다. 같은 source commit의 실제 Codex 일반 복구 뒤 새 Run과 overflow summary 복구 뒤 새 Run 각각 1회가 통과했다. natural cleanup proof·logical request SHA·head 변경·재시작 결정 보존과 원래 outcome/usage/control을 확인했다. 실제 unresolved 프로젝트 기록에는 결정하지 않았고 GUI를 실행하지 않았다. 다음은 이미지 외 native 입력 계약의 로컬 엔진 범위를 조사·구체화하면서 원래 외부 OS/provider/CI 조건을 유지한다. [최신 근거](engine-goal-verification.json)에 모든 실패와 한계를 남기고 goal을 계속 진행한다.

## 아홉 번째 검토 지점

`cc1c42b`에서 G1-21 PDF 원본 입력을 이미지와 별도 계약으로 연결했다. input/Run/message/inbox exact refs, owner/hash/CAS/blob, DB8 partial latest document index, 표준 Responses input_file 및 provider/model의 명시적 PDF capability를 검증한다. 알 수 없는 PDF page/text 토큰 비용은 기본 거절하고 엔진과 provider의 explicit opt-in을 동시에 요구한다. full token fit을 주장하지 않는다. default 원본 유지와 별도 document-history opt-in, user text·latest PDF·image dual anchors, summary coverage/source pin·archive/root 진단은 [PDF 명세](engine-input-documents.md)를 따른다.

실제 임시 엔진→mock HTTP 17개로 admission/dispatch/재시작/24개 read exchange/archive/unknown-token/tamper/local cleanup을 검증했다. 독립 검토에서 adapter policy preflight 누락, active image 이중 reservation, PDF context 초과의 prefix 재계획 누락, dual 외부 Run 순서·cursor 역전을 재현해 수정했다. 전체 2,206 pass·실패 0·Windows 조건 2 skip, fixture 3/3이며 같은 커밋 actual Codex text 회귀 1회가 통과했다. 실제 원격 PDF 요청은 0회다.

[여덟 번째 JSON](engine-goal-eighth-verification.json)은 `7a5a844`의 bytes 그대로 보존했다. 이 시점의 원격 PDF/parser/token 및 child index 재귀 감사 한계는 [아홉 번째 JSON](engine-goal-ninth-verification.json)에 보존했다. G1-22 managed child 문서 owner·archive/진단 coverage는 아래 열 번째 검토 지점에서 구현했다. 외부 OS/provider/CI 4개와 GUI 제외를 유지하며 goal은 활성 상태다.

## 열 번째 검토 지점

`9bf0e7f`에서 G1-22 root/child 저장 binding·physical owner lease·private immutable mirror·선택 문서 진단·아카이브 감사와 inactive child import를 연결했다. prepared/admitted는 두 DB의 독립 commit이며 실제 child close 뒤 root만 종료 증거를 기록한다. selected proof는 공통 8MiB/ref/record 예산을 사용하고 unknown 총량은 null이다. 원래 child main을 SQLite로 열지 않으며 source owner·native quiescence·blob/captured manifest를 검사한다. 외부/nondefault 내부/restored physical mapping과 extra runtime artifact의 한계를 명시했다.

독립 실제 host 검토는 incomplete 총량의 0 표시, native 활성 기록의 누락, 같은 크기 PDF가 최초 검증과 final capture 사이 바뀌어 invalid archive가 publication되는 경합을 재현했다. 수정 전 로그와 source/bundle 검증을 보존했다. 전체 gate는 2,274 pass·실패 0·조건부 2 skip, 코딩 fixture 3/3이다. 같은 source commit에서 실제 Codex 자식 text 요청 1회, natural cleanup·selected index·archive/validate·child pause import·restored source reexport 거절·임시 경로 제거를 확인했다. Root와 PDF 원격 요청은 0회다.

[아홉 번째 JSON](engine-goal-ninth-verification.json)은 `53241e7`의 bytes 그대로 보존했다. [최신 검증](engine-goal-verification.md)과 [저장 계약](engine-child-document-storage.md)을 따른다. 다음 G1-23은 실제 SIGKILL·재시작에서 두 DB phase·원래 outcome/usage/ACK·worktree owner를 확인한다. 자동 재호출·보충·재인증은 하지 않는다. 외부 OS/provider/CI 4개와 GUI 제외를 유지하며 goal은 활성 상태다.

## 열한 번째 검토 지점

`bd14b32`에서 G1-23 actual root/child SQLite의 준비·admission·partial native·terminal/close·task outcome/worktree release 7경계를 SIGSTOP/SIGKILL하고 재시작·exact retry했다. 기존 결과/usage/ACK/context/child 파일을 보존하며 자동 provider 호출·child engine·mirror 보충·close 추정·owner release는 0이었다. 독립 복구 6개와 owner process 7개를 포함해 새 검증 20개가 source/private bundle에서 통과했다.

실제 reader 강제 종료 뒤 446,464B private DB pathname 잔존을 개선해 darwin/linux에서 검증한 immutable handle을 유지하면서 private pathname을 제거한다. 반환 뒤 kill 잔존 0, copy 도중 262,144B 잔존, hot writer WAL 24,752B/JSON 본문 0, 여러 lease·readIndex/backup·explicit successor writer를 구분했다. Linux/Windows나 전원 차단·원격 cleanup 보장으로 확대하지 않는다.

전체 gate 2,294 pass·0 fail·조건부2 skip, coding fixture 3/3, 같은 source commit 실제 Codex child text 1회·natural cleanup·archive/validate·child pause import·임시 경로 제거가 통과했다. [열 번째 JSON](engine-goal-tenth-verification.json)은 `15abacd`의 bytes 그대로 보존했다. 다음 G1-24는 exact manifest를 pin한 historical selected child document host 조회이며 검증 중 얻은 index를 같은 frame으로 재사용한다. 기존 외부 OS/provider/CI 4개·GUI 제외를 유지하며 goal은 활성 상태다. [최신 검증](engine-goal-verification.md)을 따른다.

## 열두 번째 검토 지점

`8c07e28`에서 G1-24 standalone historical child 문서 조회를 public export했다. Exact manifest/root native owner/task preflight 후 전체 archive proof의 같은 frame·이미 검증한 index를 재사용하고 document metadata samples와 counts/unknown/partial을 반환한다. 실제 nested/11child subset·legacy/external·tamper/oversized owner·report/sample/proof cap·원본/archive stat/SHA 보존을 확인했다.

독립 actual 검토의 사전/진입후 signal shadow와 observerless 부분 수정 실패를 재현하고 operation-scoped active native observer/finally release로 수정했다. 기존 public archive validation의 proof-only deadline도 controlled-clock 회귀 뒤 복원했다. Scope와 native composite 제한은 [조회 계약](engine-archive-child-document-inspection.md), [조사](research/2026-10-07-archive-child-inspection.md)를 따른다.

전체2,331 pass·0 fail·조건부2 skip, fixture3/3, 같은 source 실제 Codex child text1회→host PDF metadata historical 조회→pause import·임시경로 제거가 통과했다. Remote PDF 요청0이다. [열한 번째 JSON](engine-goal-eleventh-verification.json)은 `d341644`의 bytes 그대로 보존했다. [최신 검증](engine-goal-verification.md)을 따른다.

다음 G1-25는 actual local HTTP peer의 승인된 효과가 진행 중인 timeout/disconnect/cancel 뒤 새 Run이 허용된3red와 native restart의 불확실성 누락을 수정한다. MCP tools/call의 exact dispatch/outcome 증거를 provider cleanup과 별도 영속 기록으로 결합한다. 전송 intent가 remote acceptance 증명이라고 주장하지 않으며 기존 ACK를 새로운 효과 권한으로 확장하지 않는다. 외부 OS/provider/CI4개·GUI 제외를 유지하며 goal은 활성 상태다.

## 열세 번째 검토 지점

`4a15286`에서 G1-25 DB9 typed MCP 호출 기록과 불확실성 차단을 구현했다. 실제 outer 승인/native owner·최종 논리 RPC/연결/catalogue를 고정하고 builtin HTTP fetch/stdio write 직전 intent, 서버 terminal 응답, request-local cleanup을 분리한다. unknown이면 모델 continuation/새 Run/queue promotion을 차단하며 원래 provider cleanup/usage·부분 출력·proposal/승인·입력과 startup/archive 격리를 보존한다.

추가 실제 committed-intent callback throw 회귀와 stdio 미전송 취소 통지, 구체 body/reader disposal·비동기 observer·custom hook 위조를 검증했다. 집중45/76/20 source·bundle와 독립 ROOT 통합 검토, 전체2,402 pass·실패0·조건부2 skip·fixture3/3이 통과했다. 같은 source 실제 Codex child text1회·host PDF54B metadata·archive/validate/import pause 회귀도 통과했으며 원격 PDF/MCP 계정 요청은0이었다. DB9/metrics6이며 [열두 번째 JSON](engine-goal-twelfth-verification.json)은 `5609755`의 bytes 그대로 보존했다.

[MCP 계약](engine-mcp-execution.md), [공개 비교·실제 증거](research/2026-10-07-mcp-effect-outcomes.md), [최신 검증](engine-goal-verification.md)을 따른다. 원격 acceptance/abort/rollback·모든 외부 background activity 종료나 receipt 없는 legacy 기록의 소급 인증을 주장하지 않는다. MCP 전용 ACK API는 아직 없다.

다음 G1-26은 MCP receipt 없는 generic native tool의 actual tool.running/execute-entered SIGKILL 뒤 workspace 차단이 유실되는2red를 수정한다. requested control은 정상이며 같은 transaction에서 시작 의도를 원래 owner로 검증해 capture하는 bounded forward 계약을 검토한다. 기존 stronger MCP 미전송/terminal proof·command/patch effect marker와 구별한다. 이미 이전 recovery가 interrupted로 다시 쓴 과거 기록에는 별도의 retrospective 정책이 필요하다. 외부 OS/provider/CI4개·GUI 제외를 유지하며 goal은 활성 상태다.
