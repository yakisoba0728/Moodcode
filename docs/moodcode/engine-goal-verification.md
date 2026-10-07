# 엔진 지속 개선 검증 — 열 번째 검토 지점

구현 커밋은 `9bf0e7f7339eaac754725d6e1f22e968a958f0b2`다. macOS arm64 / Node 26.9.0에서 G1-22 managed child 문서 저장소의 영속 binding·명시적 진단·아카이브 감사·inactive import를 연결했다. Goal은 활성 상태다. GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency 2 | 2,276개 중 2,274 pass, 실패 0, 취소 0, OS 조건 2 skip; 73,983.1ms |
| fixture 코딩 평가 | 3/3 |
| root 실제 host 경계 | 5/5 |
| binding 담당 source / 독립 bundle | 각각 13/13 |
| reader·진단 담당 source / 독립 bundle | 각각 30/30 |
| archive 담당 source / 독립 bundle | 각각 32/32 |
| 독립 실제 wiring source / bundle | 각각 4/4 |
| live script의 private mock 검토 | 통과; 실제 계정 요청 0 |
| 같은 source commit 실제 Codex 자식 text 요청 | 1회 통과; 실제 root/PDF 요청 0 |

Scoped 검증은 서로 겹치며 전체 gate에도 포함되므로 더하지 않는다. 기존 test manifest를 축소하지 않았다. command·log SHA, 구현 파일 18개의 SHA, 실패와 수정 근거는 [검증 JSON](engine-goal-verification.json)에 있다. 다른 OS·Node24·hosted CI의 성공으로 확대하지 않는다.

## 연결한 동작

Root의 `child.storage.<taskId>`와 child의 `engine.child_owner`가 task·request·Run/session/workspace·nested 계보·historical worktree·configured path·DB/owner/artifact 물리 identity를 결합한다. prepared와 admitted는 두 독립 DB commit이며 원자 commit을 주장하지 않는다. 실제 child `engine.close()`가 resolve한 뒤 root만 close proof를 추가한다. immutable admitted mirror는 보존한다. 기존 4-argument EngineChildren constructor도 유지하되 legacy 경로의 새 소유권을 추정하지 않는다.

명시적 `getChildDocumentStorageUsage`는 exact owner와 선택한 task만 읽는다. Root owner 선택·primary index는 한 transaction이며 child proof/index도 같은 monotonic 8MiB metadata·2,048 refs·8,192 charged records 예산을 공유한다. 기본 child 선택 8개, 상한 32개, 보고서 기본 32KiB다. unknown/partial 총량은 `null`, 관측한 부분합은 별도다. 이 API는 blob contents/hash·orphan·이미지·worktree·physical disk bytes를 검사하거나 삭제하지 않는다.

기존 child owner의 read lease 아래 원래 main DB를 nofollow FD로 private mirror에 복사하고 immutable SQLite URI로 읽는다. 원래 child main을 SQLite로 열지 않는다. physical identity·sidecars·native quiescence·exact owner를 index body 전에 검사한다. 원본 파일당 32MiB/operation 합계 256MiB의 raw mirror는 선택 metadata와 별도 예산이며 2초 deadline은 협조적 경계 검사다. 모든 SQLite 내부 탐색·scalar·전체 I/O·allocation의 상한이 아니다.

아카이브는 기본 내부 child의 close/binding을 확인하고 lease를 publication까지 유지한다. standalone DELETE child snapshot과 exact document refs/blob·manifest members를 검증한다. Audit field를 없애 typed binding을 opaque legacy 보관으로 낮추지 못한다. Final captured member의 bytes/hash/path도 최초 문서 refs와 publication 전에 비교한다. 전체 DB logical hash/integrity는 8MiB 선택 proof 예산 밖이며 iterator를 사용해도 각 큰 row allocation의 같은 상한을 보장하지 않는다.

Import는 verified child session도 pause한다. 원래 outcome/usage/ACK/mirror/physical binding을 보존하고 실행·자동 resume·새 worktree authority를 만들지 않는다. 외부 child는 explicit unchecked/partial, nondefault 내부 child base와 restored typed-child fresh-source 재보관 mapping은 아직 지원하지 않는다. 추가 effect/PTY/review SQLite 파일의 hash 보존은 typed runtime owner 검증을 뜻하지 않는다. [상세 저장 계약](engine-child-document-storage.md)을 따른다.

## 재현하고 수정한 문제

Baseline 실제 temporary parent/child 엔진에서 root lease만으로 child writer를 막지 못했고, 자식 document owner/hash 변조가 opaque archive 검증을 통과했다. 별도 SQLite fixture는 readOnly connection도 원래 WAL DB의 sidecar를 만들 수 있음을 보였다. 새 read lease/private immutable mirror와 bounded owner 검증의 근거이며 실제 사용자 프로젝트 피해나 upstream 제품의 결함 보고가 아니다.

독립 검토는 불완전한 primary/child 총량을 0으로 표시하는 문제, 원래 Run/close proof는 유지한 채 native Turn/Attempt가 미완료로 바뀌어도 감사가 통과하는 문제를 재현했다. 각각 unknown/null와 본문 전 quiescence 검사로 수정했다. 같은 크기의 PDF가 최초 검증과 final capture 사이에 바뀌면 export는 성공하지만 바로 validate가 실패하는 실제 await 경합도 확인해 captured member 재검증으로 수정했다. 수정 전 로그와 수정 후 source/bundle 근거를 보존했다. 병렬 fixture 작성 순서·API 인자·noEmit 타입 오류는 엔진 correctness 실패와 구분했다.

## 실제 계정 회귀

`verify-child-document-storage.mjs --live`는 authored temporary Git 저장소의 synthetic parent 아래 도구 없는 실제 Codex `gpt-6.1-sol` 자식 text 요청을 1회 실행했다. READY 완료, natural iterator `confirmed/iterator-next-done/natural-done`, 정확한 admitted mirror와 root-only close를 확인했다. 입력 266/output 5 tokens가 관측됐고 billedTokens는 unknown이다. Logical request는 1,746 bytes, SHA `d80d372a4fa5c167938f1b91a030fbb9e825c74541fbf36979a5f45b4ef58dae`이며 raw HTTP body의 SHA가 아니다.

Host가 import한 opaque signature-only PDF 54 bytes는 실제 모델 요청에 포함하지 않았다. 진단은 selected metadata 9,347 bytes·23 charged records·ref 1개, raw mirror 454,656 bytes를 관측했다. Blob hash는 진단 범위 밖이며 archive에서 검증했다. Archive/validate/import가 통과했고 child session 1개를 pause했다. Restored typed-child reexport는 명시적으로 거절했다. Whole-session snapshot 0회, 추가 실제 요청 0회였고 host close 뒤 소유한 임시 경로를 제거했다. 실제 unresolved 프로젝트 기록에 ACK하지 않았다.

## 보존과 다음 작업

[아홉 번째 JSON](engine-goal-ninth-verification.json)은 `53241e7`의 원본 bytes 그대로 보존했다. SHA는 `c218f60815f981c4263515ea15d5cfb029dbfee47634860431340af53aaf5250`다. 앞선 PDF/이력/token 정책과 DB8/metrics6 계약을 유지했다.

다음 G1-23은 실제 child prepared/admitted/terminal/close/outcome·worktree release 사이의 SIGKILL·재시작을 검증한다. 현재 Map 기반 쓰기 실패와 정상 close 후 재시작의 결과를 실제 강제 종료 증거로 표시하지 않는다. 자동 provider 재호출·mirror 보충·ACK·owner 해제 없이 원래 phase/결과를 보존하는지 확인한다. 원격 PDF/parser/token 비용, audio/video, 다른 계정·OS·CI와 E5-08/E5-13/E6-07/E6-08은 계속 열린 상태다. [TODO](../../TODO.md)와 [지속 개선 목표](engine-improvement-goal.md)를 따른다.
