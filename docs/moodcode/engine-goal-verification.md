# 지속 개선 최신 검증

2026-10-07, macOS arm64 / Node 26.9.0. 두 번째 구현 commit은 `59d1f42716452e104ec526e031263b528b36078b`다. [기계 판독 결과](engine-goal-verification.json), [목표](engine-improvement-goal.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

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
