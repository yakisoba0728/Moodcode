# 엔진 지속 개선 검증 — 열한 번째 검토 지점

구현 커밋은 `bd14b324f128029b33aaf71e61ce6c3f038ed622`다. macOS arm64 / Node 26.9.0에서 G1-23 실제 child crash 경계를 검증하고, 정상 reader 반환 뒤 강제 종료할 때 임시 DB 복사본 경로가 남는 문제를 개선했다. Goal은 활성 상태이며 GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency 2 | 2,296개 중 2,294 pass, 실패 0, 취소 0, OS 조건 2 skip; 76,620.9ms |
| fixture 코딩 평가 | 3/3 |
| 실제 engine SIGKILL source / 독립 bundle | 각각 7/7 |
| 독립 실제 복구 경계 source / bundle | 각각 6/6 |
| 실제 owner/reader process source / bundle | 각각 7/7 |
| 기존 reader·archive·host 집중 source | 31/31 |
| 같은 source commit 실제 Codex child text | 1회 통과; root/PDF 원격 요청 0 |

새 20개 검증도 전체 gate에 포함되며 scoped 결과를 더하지 않는다. 기존 test manifest를 축소하지 않았다. Source·log SHA, 실제 phase의 raw fixture 증거, 실패와 한계는 [JSON](engine-goal-verification.json)에 기록했다. 다른 OS·Node24·hosted CI의 실제 성공으로 확대하지 않는다.

## 실제 프로세스 중단

Authored Git 저장소의 actual root/child MoodcodeEngine·SQLite를 실행하고, committed boundary에서 IPC로 준비를 확인한 뒤 SIGSTOP·외부 SIGKILL을 적용했다. root prepared→mirror 전, child Run admission→admitted 전, root admitted→mirror 전, 부분 text/usage 저장 뒤, child terminal→close 전, root close→task outcome 전, outcome→worktree release 전의 7개 지점을 검증했다.

재시작과 exact start retry는 새로운 provider 요청·child engine·mirror 보충·close 증거·ACK·worktree owner 해제를 만들지 않았다. 원래 request/phase·부분 출력·usage·cleanup/ACK·context와 child 파일의 inode/mtime/SHA를 보존했다. 사전 준비한 unknown 결과와 ACK 1개는 로컬 authored fixture다. Early phase의 전체 local call count 2→2, later phase 3→3이며 실제 계정이나 프로젝트 ACK가 아니다. 정상 close와 Map write 실패를 이 실제 강제 종료 결과로 대체해 표시하지 않았다.

Root reopen의 interrupted 복구와 명시적인 child journal recover는 다르다. 후자는 unfinished task를 uncertain으로 남기며 child DB를 자동으로 복구하거나 실행하지 않는다. close proof가 있어도 task 결과가 미확정이면 source/historical audit을 완료로 승격하지 않는다. Outcome commit이 끝난 경우에는 그 결과를 보존하지만 남은 worktree owner는 임의로 해제하지 않는다. 문서 감사의 complete는 cleanup이나 실행 권한을 뜻하지 않으며 cleanup은 WORKTREE_BUSY로 차단된다. Archive/import에서도 pause와 original owner·relocation ownershipVerified=false를 확인했다.

## 임시 mirror의 수명 개선

기존 소스의 실제 held reader를 SIGKILL하면 private DB 446,464 bytes와 디렉터리가 남았다. OS는 owner read lease를 해제했고 원본 파일은 변하지 않았지만 finally cleanup은 실행되지 않았다. 새 구현은 darwin/linux에서 source/native/mirror 검증이 끝나고 immutable SQLite handle을 연 뒤, 자신이 만든 private copy의 pathname을 제거한다. 열린 핸들과 owner lease는 close까지 유지한다.

실제 child reader의 readIndex·attached-source backup·writer 차단이 유지됐다. Reader 반환 뒤 SIGKILL의 잔여 pathname bytes는 0이었고, reader 2개 중 하나만 죽이면 다른 lease는 유지됐다. 원본 DB/owner/artifact의 inode·mtime·ctime/SHA도 보존했다. 열린 anonymous file은 모든 핸들이 닫힐 때까지 디스크 공간을 유지한다. 읽기 중 할당량이 0이라는 측정은 아니다.

복사 두 번째 chunk 전 SIGKILL에서는 262,144 bytes가 남았다. 테스트가 정확한 known inode를 확인하고 자신이 만든 잔여물만 명시적으로 제거했다. 일반 stale directory 검색·자동 삭제는 추가하지 않았다. 실제 writer SIGKILL로 WAL 24,752 bytes가 남으면 reader는 HOT_DATABASE로 거절하고 JSON body를 읽지 않았다. 명시적인 successor writer의 복구는 별도 동작이다. Linux/Windows에서 이번 강제 종료를 실행하지 않았다.

SQLite row와 IPC row prototype, 최초 binding 저장 전 legacy partial archive 기대, 빈 owner의 rollback journal 경계에 관한 초기 fixture 실패는 production 실패와 구분해 보존했다. SIGKILL은 이 로컬 process boundary의 검증이며 전원 차단 내구성·원격 서버 완료/취소/과금의 증거가 아니다. [조사 근거](research/2026-10-07-child-crash-boundaries.md)와 [저장 계약](engine-child-document-storage.md)을 따른다.

## 실제 계정 회귀와 보존

같은 source commit에서 도구 없는 Codex `gpt-6.1-sol` child text 요청 1회가 READY로 완료했다. Input 266/output 5 tokens, natural `confirmed/iterator-next-done/natural-done` cleanup, root-only close와 admitted mirror를 확인했다. Logical request 1,746 bytes, SHA `bc464cd944bbd6ce34d29157560c883c31d152df60b292a835e42e2c24291084`이며 raw HTTP body SHA가 아니다. BilledTokens는 unknown이다.

Host가 import한 opaque PDF 54 bytes는 모델로 보내지 않았다. selected index·archive/validate·child session 1개 pause import·restored source reexport 거절이 통과했다. Snapshot 조회 0회, 추가 실제 요청 0회였고 host close 뒤 임시 경로를 제거했다. 실제 unresolved 프로젝트 기록에는 ACK하지 않았다.

[열 번째 JSON](engine-goal-tenth-verification.json)은 `15abacd`의 원본 bytes 그대로 보존했다. SHA는 `aa83349c28e7405dde9b71713d59068b11e5a9c72dde30e82cb971a3544bd370`다. DB8/metrics6와 [G1-22](engine-child-document-storage.md)의 source/historical·metadata/raw mirror/whole hash 구분을 유지한다.

다음 G1-24는 exact verified archive manifest에서 선택한 historical child document index를 명시적으로 조회하는 host API다. 기존 검증 중 얻은 index를 재사용해 새로운 frame·재읽기·TOCTOU를 늘리지 않는다. 실행·복구·ACK·새 physical authority를 부여하지 않는다. 외부 OS/provider/CI 4개는 계속 열린 상태이며 [TODO](../../TODO.md), [지속 개선 목표](engine-improvement-goal.md)를 따른다.
