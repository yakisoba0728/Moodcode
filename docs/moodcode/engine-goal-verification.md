# 지속 개선 최신 검증

2026-10-07, macOS arm64 / Node 26.9.0. 네 번째 구현 commit은 `ede15196edc16f63ee8c4183f628c50d6745df2d`다. [기계 판독 결과](engine-goal-verification.json), [요약 수명 명세](engine-summary-attempts.md), [host API](engine-host-api.md), [TODO](../../TODO.md)를 함께 확인한다. GUI·Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,850 tests / 1,848 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 |
| 실제 요약 엔진 경계 | 19개 lifecycle, 8개 quarantine, 8개 provider cleanup, 두 scope 서비스·storage·metrics fixture 통과 |
| 실제 세션 이미지 경계 | storage 10개·actual engine 5개, 재시작/40턴/cutoff/unsupported/cap·full snapshot 0 |
| 커밋 후 실제 Codex | 요약+답변 2회, 이미지+재시작 text Run 2회 성공·종료/임시 파일 정리 확인 |

`npm run typecheck`, `npm run test:engine`, `node scripts/evaluate-engine.mjs`를 실행했다. 같은 커밋에서 `node scripts/verify-active-prefix.mjs --live`, `node scripts/verify-session-image.mjs --live`를 기존 로컬 Codex 인증으로 검증했다. 새 인증·외부 발행·GUI 실행은 수행하지 않았다.

## 네 번째 구현과 독립 검토

- **별도 요약 기록**: DB4의 typed summary attempt와 latest nullable usage를 두 요약 서비스에 연결했다. prepared/dispatch/streaming, 정상 stop+iterator 완료·확인된 cleanup, publication 대기, 실패/interrupted/uncertain을 나눈다. summary를 ordinary Turn/Attempt로 만들지 않는다. source/owner/CAS/revision metadata를 비교하고 실제 checkpoint·pointer 활성화 트랜잭션 안에서만 completed로 바꾼다.
- **실패·재시작**: 64KiB retention cap, UTF-8 잘림·surrogate split, 공유 output/summary allowance, partial usage 회귀, native/v1 journal fault와 양 pointer/revision rollback을 확인했다. prepared/dispatched/provider-completed unpublished 세 단계 실제 강제 종료 뒤 자동 retry·activation은 0이다. terminal Run의 미확인 요약도 정산하고 같은 workspace의 새 Run·첫 maintenance·다른 session resume를 차단한다. 기존 exact request 조회와 정상 workspace의 active Run pause/resume를 유지한다.
- **사용량·조회**: host의 session-bound get/list, owner-before-payload·최대 100개/1MiB page와 record cap을 연결했다. metrics schema 3은 전체 typed summary 합계와 recent legacy event window, ordinary Attempt 합계를 구분한다. synthetic SQL fixture의 typed 2,101개와 recent 2,000개 event window를 따로 검증했으며 2,101번 실제 모델 호출을 뜻하지 않는다.
- **이미지**: session-wide partial index로 최신 이미지 header 하나를 찾고 exact user·origin Run을 count/byte budget 안에 예약한다. 완료된 memory cutoff 위로 raw user와 refs를 복원한다. 새 text Run·40번 완전 tool turn·재시작·cap·잘못된 owner/reference/ordinal·지원하지 않는 provider를 검증했다. 원본 pixels/replay/refs는 수정하거나 삭제하지 않는다.
- **추가 재현 결함 수정**: 이미지 async-generator 래퍼가 inner next 실패 뒤 cleanup 성공을 잘못 전달하던 경계를 transparent iterator로 바꿨다. 일반 provider executor도 return Promise 성공만 보던 오류를 고쳐 `done === true`를 요구한다. `done:false`인 HTTP retry와 overflow recovery는 새 dispatch 없이 uncertain으로 종료한다. 두 가지 orphan quarantine 순서 문제도 실제 fixture로 재현·수정했다.

첫 전체 gate부터 실패 0이다. source focused 중 legacy Input.id와 초기 Message.id를 혼동한 이미지 fixture, 고정 DB3 migration 기대값과 native event page cap을 수정했다. 오류를 실제 production 결함과 구분해 JSON에 기록했다.

## 커밋 후 실제 모델 확인

`gpt-6.1-sol`에서 20번 fixture-directed local read 뒤 실제 요약 한 번·최종 답변 한 번을 실행했다. 원본 도구 메시지가 provider context에서 빠진 임의 32자리 값을 memory에서 정확히 회수했다. 요약 요청은 7,642 bytes, typed receipt는 completed/activated, partial text 790 bytes·truncation false, source와 summary revision binding·cleanup 기록이 일치했다. 최종 context는 14,754/16,384 bytes이고 전체 snapshot 조회는 0회였다. 이는 모델이 20턴 코딩 전략을 자율 선택한 평가가 아니다.

요약 input 2,040/output 188은 별도 durable summary 합계에, 최종 일반 Attempt input 2,695/output 24는 ordinary 합계에 기록했다. 요약 cached/reasoning 값과 20개 fixture-directed Attempt의 usage 누락을 0으로 채우지 않았다. 과금 합계는 unknown이다.

이미지 live는 첫 Run에서 실제 64×64 red PNG를 보내되 답변은 `READY`만 요청했다. 엔진을 닫고 같은 DB를 다시 연 뒤 attachments가 없는 text Run에서 색을 질문했다. 실제 모델은 red로 답했고, 두 요청 모두 정확한 이미지 frame/blob 한 개를 전송했다. 두 번째 최신 user에는 image attachment가 없고 anchor는 첫 Run의 original message와 일치했다. raw image message는 한 개, DB/context의 base64 pixels는 0이며 full snapshot 조회도 0회였다. 최종 context 2,242/8,192 bytes, 두 일반 Attempt 합계 input 592/output 20·reasoning subset 8이며 image token 비용은 unknown이다.

## 남은 범위

G1-13/14는 완료했다. 다음 G1-15는 요약 usage/progress 조회에서 retained text를 반복 읽는 비용과 admission uncertainty SQL index를 최적화하는 작업이다. G1-16은 unresolved summary의 명시적인 host recovery 결정 계약이다. 현재 uncertainty를 자동으로 해제하거나 원래 요약을 재실행하지 않으며 workspace 격리가 지속된다.

이미지 token 비용·audio/video/file 입력과 media 출력·실제 Anthropic 계정·Windows native Job backend·hosted Linux/Windows/Node24 CI·GUI 노출은 미완료다. Git remote는 없다. metadata/source/coverage cap 안에 남는 관측만 기억하며 SQLite의 전체 물리 I/O 상한은 보장하지 않는다. goal은 활성 상태다. 아래 이전 live 과업은 각각 해당 구현 commit의 근거로 보존한다.

---

# 세 번째 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 세 번째 구현 commit은 `04031cb38fb6d98d292ee93ade1240a04c63b10e`다. [세 번째 기계 판독 결과](engine-goal-third-verification.json), [active-prefix 명세](engine-active-prefix.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,777 tests / 1,775 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 |
| 실제 20/50턴 engine fixture | 첫 도구 관측의 임의 nonce를 exact quoted source→derived memory로 유지, 비활성 대조군에서는 최종 context에서 제거 |
| 실제 prefix 경계 | steer·memory/head CAS·cancel/exact retry·close·overflow same-Turn retry·변경된 frontier의 retry 중단·필수 context/output/source cap |
| 커밋 후 실제 Codex | `gpt-6.1-sol` 요약 1회·최종 답변 1회, 원본 도구 메시지가 요청에서 빠진 임의 값 정확히 회수, cleanup 확인 |

`npm run typecheck`, `npm run test:engine`, `node scripts/evaluate-engine.mjs`, `node scripts/verify-active-prefix.mjs --live`로 확인했다. 실제 검증은 20번의 fixture-directed local `read_file` 뒤 실제 model summary 한 번과 최종 답변 한 번이다. 모델이 20턴 코딩 전략을 자율 선택한 평가로 표시하지 않는다. summary source는 4개 exact messages/7,642-byte 요청이며 최종 context는 envelope 포함 14,754/16,384 bytes다. 원본 관측과 refs/replay를 보존하고 full snapshot 조회는 0회였다.

실제 summary usage는 input 1,988/output 187, 최종 일반 Attempt는 input 2,689/output 21이다. 요약의 cached/reasoning 값은 null이고 일반 Attempt 합계는 summary를 포함하지 않는다. 20개 fixture-directed Attempt의 미제공 usage도 0으로 만들지 않았다. 과금량은 unknown이다. 기존 로컬 Codex 인증만 사용했고 임시 DB·저장소의 종료·삭제를 확인했다.

## 세 번째 구현과 독립 검토

- **의미 기억**: initial goal/latest steer/image user/recent complete exchange를 보호하며 exact typed text/tool facts만 old whole exchange 단위로 요약했다. 준비된 기억과 실제 모델 ContextPlan이 모두 검증된 뒤 source/owner/frontier/CAS를 재확인해 두 revision·document와 v1/v2 activation events를 함께 저장한다. checkpoint metadata도 immutable summary revision에 hash bind한다.
- **예산과 실패**: 알려진 모델 reserve와 실제 JSON envelope/escaping을 먼저 예약한다. 이미 관측한 output delta는 local summary cap이 거부해도 공유 Run 예산에 남는다. 이전 checkpoint의 protected suffix가 커져 초기 계획이 실패하면 다음 checkpoint로 한 번 회복할 수 있다. steer arrival·CAS·취소·불완전 출력에는 이전 기억을 유지한다.
- **실행·저장 경계**: ordinary logical Turn/Attempt를 summary용으로 만들지 않는다. overflow recovery는 출력 전 failed Attempt와 underlying iterator cleanup 증거를 요구하며 source가 바뀌면 stale retry를 중단한다. tool facts·Part/Attempt의 payload↔SQL owner와 aggregate byte probe를 검증했다. 물리 SQLite 읽기량을 이 cap으로 보장하지 않는다.
- **이미지와 일반 요약**: 최신 active Run의 중간 이미지가 이후 text steer 때문에 window에서 빠지던 실제 40턴 실패를 수정했다. media projection과 prefix의 required IDs를 합쳐 pixels/ref anchors를 보호했다. completed-history summary는 provider 전에 캡처한 memory revision을 CAS에 사용해 늦은 summary가 승자를 덮어쓰지 않도록 고쳤다.

독립 source/compiled 16개 actual prefix integration과 14개 context·17개 storage fixtures가 의미·소유·byte·negative outcome·이미지·정리를 검증했다. 전체 gate의 첫 실행은 기존 Git diagnostics fixture가 비어 있는 준비 marker를 PID 0으로 읽어 실패했다(1,775 tests / 1 fail). 빈 marker 대기·PID 검증과 결정적 회귀를 추가했다. 최종 frozen source의 전체 1,777개는 실패 0이며 두 로그 hash와 실패 원인을 JSON에 기록했다.

## 남은 범위

G1-09a/b는 별도 host opt-in으로 완료했다. 다음 G1-13은 summary의 전용 durable lifecycle/usage·crash/close 복구다. 현재 Run recovery가 미공개 candidate를 자동 활성화·재시도하지 않지만 summary interrupted/uncertain 상태를 별도 record로 복원하지 않는다. G1-14는 active Run 밖 이전 Run의 최신 이미지 anchor다. 현재 메타데이터 1,024 messages/Turns, 64 pending steer, source/coverage cap 이상의 모든 과거 관측을 기억한다고 보장하지 않는다.

이미지 token 비용, 실제 Anthropic·다른 media 입력/출력, Windows native Job backend, hosted Linux/Windows/Node24 CI, 새 GUI 노출은 미완료다. Git remote는 없으며 goal은 활성 상태다. 이전 live 과업은 아래 해당 구현 commit의 근거로 보존하고 이번 커밋에서 재실행했다고 표시하지 않는다.

---

# 두 번째 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 두 번째 구현 commit은 `59d1f42716452e104ec526e031263b528b36078b`다. [두 번째 기계 판독 결과](engine-goal-second-verification.json), [목표](engine-improvement-goal.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,715 tests / 1,713 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 |
| 실제 Codex 이미지 이력 | 커밋 후 `gpt-6.1-sol` 도구 없는 요청 2회 완료·red 인식 2/2 |
| 실제 image transport·storage | 두 요청 모두 1 frame/1 resolved blob, 두 번째에 old occurrence 1개 provenance, 원본 refs 2개 유지, bounded disk index 1개·후보 0개·삭제 없음 |
| 긴 세션·자원 수명 | 130개 세션, 128 pinned 관찰, 취소/저장 실패 후 cache 슬롯 반환, 실제 disk close 대기 |

`npm run typecheck`, `npm run test:engine`, `node scripts/evaluate-engine.mjs`, `node scripts/verify-media-history.mjs --live`로 확인했다. 마지막 live 실행은 구현 commit 이후이며 현재 로컬 Codex 인증과 자체 64×64 빨간 PNG를 사용했다. 새 credential을 만들거나 계정 내용을 출력하지 않았으며 임시 DB·이미지·저장소의 종료와 삭제를 확인했다. 이미지 token 비용은 계속 unknown이고 text/ref estimate의 `complete:false`도 유지된다.

## 두 번째 구현과 독립 검토

- **디스크 진단**: 주 DB owner/ref index와 engine-owned canonical 경로를 host API로 연결했다. regular-file logical 크기·inode 중복·DB sidecars·scan coverage·sample/JSON cap·취소를 표시한다. raw contents를 읽거나 orphan을 삭제하지 않는다. 주 DB index는 child DB를 포함하지 않으며 관찰 후보가 active import의 publish→CAS 사이에 생길 수 있다.
- **이미지 이력**: 생성 시 명시한 host opt-in으로 이전 pixels만 생략한다. 원문 text/ID/refs/replay를 보존하고 최신 pixels·goal/latest steer·complete exchange·quoted notice를 필수로 budget에 넣는다. metadata가 부족하면 이전 context head를 유지하고 provider 호출 전에 실패한다. summary/overflow recovery는 원래 image source를 검사한다.
- **bounded 실행 조회**: 유지보수 입장과 exact 요청, 승인 생성/취소, child pending 승인·terminal assistant 결과를 소유자 범위 SQL로 읽는다. 실제 retry/child allow·부모 cancel·자식 cancel 7개 fixture는 전체 snapshot을 처음부터 금지해도 종료까지 통과했다. queue pending/steer를 primary Run 요청으로 오인하지 않는다.
- **지침 cache 수명**: idle LRU 128개와 observe lease로 오래된 세션 수 때문에 이후 실행이 막히던 문제를 수정했다. cache eviction 후 baseline은 저장 문서의 root/scope/hash 검증을 거쳐 복원하고 실제 파일 삭제는 baseline을 제거한다.

독립 검토는 full image index를 붙인 반환이 4,096-byte cap을 7,053 bytes로 넘던 결함과 큰 저장 revision의 SQLite RangeError를 재현했다. 반환을 bounded scanner report만 유지하고 SQL revision/rowid projection을 수정한 뒤 실제 fixtures가 통과했다. child allow/cancel과 maintenance가 남겨둔 full-snapshot 경로도 해당 독립 fixtures로 확인해 수정했다.

source 22개 이미지 policy fixture와 독립 compiled, 실제 ContextService/SQLite 5개, 디스크 facade/close 3개, cache 수명 3개·host 옵션 1개, owner-bound SQL·실제 filesystem fixture를 포함한 전체 compiled gate가 성공했다. 이 검증을 API만 있는 미연결 모듈이나 mocked HTTP 결과와 구분한다. 이전 coding/delegation live는 아래 `64435d7`의 근거이며 이번 커밋에서 다시 실행했다고 표시하지 않는다.

## 다음 구현 범위

G1-08, G1-09a, G1-11, G1-12는 완료했다. **G1-09b active-prefix semantic checkpoint**는 아직 설계 단계다. active Run의 exact source/hash·complete boundary·Run/turn/attempt owner·CAS 계약, 중간 steer와 summary 취소/출력/정리 실패, 원문 anchors·pixels·replay 보존을 다음 묶음에서 구현·검증한다. 이력 생략이나 extractive excerpt를 의미 요약 완료로 표시하지 않는다.

디스크 수치는 물리 할당량이나 원자 snapshot이 아니며 자동 retention/삭제를 수행하지 않는다. 이미지 정책은 host opt-in이고 source/provenance도 hard cap 안에서만 활성화된다. 실제 Anthropic·audio/video/file·media 출력, Windows native Job backend, hosted Linux/Windows/Node24 CI, 새 기능의 GUI 노출은 완료 처리하지 않았다. 현재 Git remote가 없고 goal은 활성 상태다.

---

# 첫 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 구현 commit은 `64435d705ea6e68d7e3502d64d4fd1f2976004ae`다. [첫 묶음 결과](engine-goal-first-verification.json), [목표](engine-improvement-goal.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,646 tests / 1,644 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 확인 |
| 실제 Codex 기본 coding 과업 | read_file→승인 apply_patch→승인 run_command, 변경·테스트·cleanup 확인 |
| 실제 Codex 확장 과업 | 승인된 parent→read-only child→동일 요청 재사용, 이미지 red 인식 2/2 |

실제 모델은 기존 로컬 Codex 인증의 `gpt-6.1-sol`이다. 위임은 child의 실제 DB에서 완료 read_file 1회를 확인하고 결과의 자동 inbox 전달·병합이 없음을 확인했다. 이미지 인식은 자체 생성한 64×64 빨간 PNG와 도구 없는 응답으로 검증했으며 원본 bytes가 transcript/context에 저장되지 않았음을 확인했다. 모든 과업은 임시 저장소에서 실행하고 정리했다. 다른 모델·계정·provider에 결과를 확대하지 않는다.

## 구현과 독립 검토

- DB3의 latest-per-attempt usage: 반복·부분·safe retry·provider 실패·취소·native/v1 journal 실패·terminal 불변·재시작·archive.
- bounded active history: 1k/10k SQL window, 실제 36턴/560개의 서로 다른 완료 read, 8KiB context의 24턴/92개 완료 read, 초기 목표·latest steer·완전 exchange·원본 replay 보존.
- immutable image store와 transport: owner/CAS/hash/MIME/container/size/animation/symlink/close·archive, 실제 admission/context/provider 연결, unsupported 입력/출력 거부.
- delegate_task: 요청별 exact approval·pinned committed snapshot·읽기 도구·부모 잔여 budget·취소·중복·효과 잠금·복원·초기화 수명.

독립 검토는 이미지의 text-only 의미 요약·extractive pruning·receipt 재조회, live Run 전체 exchange의 조기 필수화, archive worktree path, async configureChild 반환 문제를 발견했다. 수정한 뒤 교차 fixture와 전체 gate를 통과했다. [이미지 검토](research/2026-10-07-image-integration-review.md), [위임 검토](research/2026-10-07-delegation-review.md), [실제 loop 측정](research/2026-10-07-accounting-review.json)을 따른다.

마지막 전체 gate의 한 실행은 exit 137로 중단되어 성공 결과로 사용하지 않았다. 종료 원인은 확인하지 못했다. 같은 최종 source의 재실행이 1,646개 전체를 통과했으며 JSON에 이 중단과 완료 실행의 로그 hash를 기록했다.

## 남은 범위

이미지 token 비용은 unknown이며 container 검사는 pixel decoder가 아니다. active-prefix 생략을 의미 요약으로 간주하지 않는다. DB bounded snapshot 밖의 이전 이미지와 active-prefix 의미 요약은 다음 범위이며, 이후 구현된 디스크 진단·명시적 이미지 정책은 위 두 번째 검증을 따른다. 복원 worktree는 ownership 미확인 역사 데이터이며 verify/start/merge/cleanup을 거부하고 fresh 작업은 별도 worktree를 만든다.

audio/video/file 입력, media 출력, 실제 Anthropic 계정, Windows native Job backend, hosted Linux/Windows/Node24 CI, GUI 새 기능 노출은 완료 처리하지 않았다. 현재 Git remote가 없어 hosted CI를 실행하지 않았다. goal은 활성 상태로 다음 구현을 계속한다.
