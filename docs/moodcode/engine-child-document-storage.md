# Managed child 문서 저장과 보관

GUI와 모델 도구의 자동 동작이 아닌 명시적 host API다. 실제 child를 소유한 엔진이 기록한 storage binding만 조회 후보로 삼는다. [비교와 baseline](research/2026-10-07-child-storage.md), [PDF 입력](engine-input-documents.md), [기존 파일 사용량 진단](engine-storage-usage.md)을 함께 따른다. 완료 여부와 source commit은 [최신 검증](engine-goal-verification.md)을 기준으로 한다.

## 저장 수명

MoodcodeEngine의 child host는 child session 생성 후 root session의 `child.storage.<taskId>`와 child session의 `engine.child_owner`에 schema 1의 prepared binding을 기록한다. 두 DB 사이에 원자 commit이 있다고 주장하지 않는다. 동기 scheduler admission 직후 admitted binding에 정확한 child Run ID를 넣고 양쪽 CAS를 마친다. provider dispatch는 이후에 진행한다. 중간 실패·반쪽 기록은 미확인 상태이며 자동으로 보충하지 않는다.

Binding은 nonce·root/parent Run과 task 계보·request fingerprint·child session/workspace·역사적 worktree identity·configured child base·allowlisted 상대 경로·root/child DB와 owner/artifact의 물리 identity 및 SHA를 결합한다. nested root-manager child는 같은 root namespace의 실제 부모 task와 child Run을 요구한다. 메모리 root의 identity도 해당 host lifetime의 UUID를 유지한다.

실제 child `engine.close()`가 resolve한 뒤 ROOT만 `confirmedClose`를 추가한다. child mirror는 admitted binding을 보존한다. 종료 시각은 원격 모델 완료·billing·성공한 결과를 증명하지 않는다. 오래된 task, missing/foreign binding, 활성·불확실한 실행, 미확인 close는 source 파일을 열 권한으로 승격하지 않는다. 기존 EngineChildren 4-argument constructor는 호환되지만 새 identity를 추정하지 않으므로 legacy coverage를 유지한다.

## 명시적 조회

```ts
const report = await engine.getChildDocumentStorageUsage({
  sessionId,
  sourceRunId: parentRunId,
  taskIds: [completedChild.id],
  signal,
  limits: { maxMetadataBytes: 8_388_608, maxReportBytes: 32_768 },
});
```

session·source Run·task IDs는 필수 data fields다. task IDs는 중복 없는 dense 배열이며 기본 선택 상한은 8개, host의 명시적 상향은 32개다. 빈 배열은 해당 owner를 확인하고 primary document index만 관측한다. request의 proxy·accessor·unknown field와 잘못된 bounds/signal을 저장 조회 전에 거절한다.

Root owner 선택과 primary index는 같은 read transaction을 사용한다. root journal/binding/owner와 child mirror/index가 하나의 monotonic 예산을 공유한다. 기본·최대 선택 metadata는 8MiB, refs 2,048개, charged header/body records는 8,192개다. SQL 반환 본문의 길이와 남은 예산을 본문 조회 전에 검사한다. 문서 index helper의 4MiB·64개 root index 기록과 child 1개 index 기록 한도도 별도로 적용한다. 이것은 모든 SQL scalar·SQLite 내부 탐색·물리 I/O의 상한이 아니다.

Source reader는 기존 DELETE owner 파일의 read lease를 유지한다. 원래 child main DB를 SQLite로 열지 않고 nofollow FD에서 새 private mirror로 복사해 immutable URI로 읽는다. 원본 inode·경로·size·mtime·ctime와 artifact ancestors를 다시 확인한다. WAL/SHM/journal이 있거나 owner를 다시 획득한 상태는 확인되지 않은 읽기로 남는다. raw main mirror는 파일당 32MiB·operation 합계 256MiB로 선택 metadata와 별도 예산이다. deadline 2초는 filesystem·SQL 경계의 협조적 검사이며 각 OS 호출의 강제 시간 상한이 아니다.

Child Run/session/workspace와 immutable mirror의 소유·phase를 확인한 뒤에만 문서 본문을 읽는다. 미완료 Turn/Attempt/Part의 metadata boolean도 먼저 확인한다. 원래 Run의 terminal 상태와 close proof만 남은 채 native 기록이 활성 상태로 바뀌었다면 검사하지 않는다. 다른 session의 index가 있으면 그 본문을 읽기 전에 거절한다. configured external child base도 정확한 source binding과 physical identity가 있는 선택 대상만 조회할 수 있다. 임의 경로를 검색하거나 unselected child를 발견하지 않는다. 취소·close는 모든 reader와 private mirror 정리를 기다린다.

darwin/linux에서는 owner/native/mirror 검증을 마치고 immutable SQLite handle을 연 뒤 자신이 만든 private copy의 pathname을 제거한다. 조회·backup handle과 owner lease는 close까지 유지한다. 실제 macOS reader 반환 뒤 SIGKILL에서 큰 복사본 경로가 남지 않았으나 복사 중/ATTACH 이전에는 partial copy가 남을 수 있다. Windows는 열린 파일 경로를 유지하며 close에서 정리한다. 열린 anonymous file은 마지막 handle 종료까지 저장 공간을 유지한다. 일반 stale directory 검색·자동 삭제 기능은 없다.

## 보고서의 의미

`complete`는 명시적으로 선택한 index 관측의 완료를 뜻한다. PDF blob contents/hash, child 이미지, worktree 파일, 디스크 할당량과 orphan 여부는 이 API의 검사 대상이 아니다. refs가 선언한 bytes를 physical store별로 계산하며 기존 parent artifact tree의 파일 bytes에 다시 더하지 않는다. 동일 document ID도 서로 다른 child store의 소유권을 합치지 않는다.

Incomplete root/child index 또는 미검사 child의 총량은 `null`이다. 알려진 child 부분합은 `observedChildSubtotal`로 별도 표시한다. report cap 때문에 child 상세를 생략하면 `reportsOmitted`와 partial 상태를 남긴다. 기본 JSON cap은 32KiB, 최소 host cap은 4KiB다. metadata가 남지 않으면 새로운 helper의 default budget으로 되돌아가지 않는다. 이 보고서는 문서를 삭제하거나 실행 권한을 부여하지 않는다.

## 아카이브와 복원

새 archive version 1 manifest의 optional `documentAudit`는 primary 검증과 실제 verified child members, partial coverage를 기록한다. bound child가 있는 bundle에서 이 field를 제거해 legacy opaque 보관으로 낮추는 것을 거절한다. 원래 binding이 없는 legacy bundle은 그대로 호환되며 child 검사를 완료했다고 표시하지 않는다. 외부 child 저장소는 archive에 포함하지 않고 explicit unchecked coverage를 남긴다.

정확히 종료한 기본 `artifactDir/children`의 내부 child는 source owner lease를 capture부터 publication까지 유지한다. child main DB는 standalone DELETE snapshot으로 만들고 raw WAL/SHM/owner 파일을 main 대신 복사하지 않는다. primary/child의 document index와 message/input refs, native/payload owner, blob size/signature/SHA와 exact manifest member를 확인한다. 누락·foreign·활성·hot·phase gap·partial proof는 publication 전에 거절한다. 다른 내부 configured base의 archive mapping은 현재 지원하지 않으며 typed proof를 opaque 파일로 낮추지 않는다. arbitrary SQLite artifact는 managed child로 추정하지 않는다.

공통 8MiB는 선택된 document/binding/ref proof의 metadata 예산이다. 기존 archive의 전체 DB logical hashing과 SQLite integrity는 이 예산 밖의 별도 전체 snapshot 검사다. hash는 row iterator를 사용하지만 각 row의 반환·canonical encoding에는 별도 8MiB allocation 보장이 없다. 원래 archive의 파일당 256MiB·합계 512MiB·manifest 4MiB 한도와 child private mirror cap을 함께 적용한다. 전체 DB hashing이 8MiB만 읽는다고 주장하지 않는다. Child effect·PTY·review 같은 추가 SQLite artifact의 현재 소유권을 document audit에서 추정하지 않으며 해당 파일의 보존·hash는 별도 typed runtime audit을 뜻하지 않는다.

최초 blob 검증 이후 backup의 await 사이에 파일이 바뀔 수도 있다. 최종 captured manifest member의 bytes/SHA/path를 이미 선택한 primary/child 문서 참조와 publication 전에 다시 비교한다. 이 검사는 같은 proof 예산의 참조를 재사용하며 본문을 다시 읽거나 예산을 초기화하지 않는다.

검증은 historical manifest allowlist·root journal·child mirror/Run/session/workspace와 document refs를 다시 결합한다. Import는 verified child session도 pause하고 원래 outcome/usage/ACK/mirror와 physical binding을 보존한다. child 실행·자동 resume·ACK·새 소유권 증거를 만들지 않는다. 복원된 typed child를 fresh source로 재보관하는 것은 현재 scope 변경으로 거절하며, 새 physical mapping을 승인하는 별도 host 계약은 후속 범위다. 역사 자료를 읽을 수 있다는 사실이 worktree/child의 실행 권한을 재인증하지 않는다.

닫힌 원래 archive의 selected child를 읽으려면 standalone `inspectArchivedChildDocumentStorage`에 exact manifest SHA와 root session/Run/task IDs를 지정한다. 전체 audit 중 검증한 index를 재사용하여 bounded metadata samples와 명시적 unknown/omission을 반환한다. 요청 cap과 전체 archive proof cap·stats scope·표시 예산은 [historical 조회 명세](engine-archive-child-document-inspection.md)를 따른다.

## 실제 crash와 task 소유권

prepared/admitted, child terminal/close, root task outcome과 worktree release는 독립된 기록 경계다. 재시작은 원래 unfinished child를 자동 실행하거나 DB를 보충하지 않는다. Root interrupted 복구와 명시적인 child task recover를 구분하며, close proof만 있는 uncertain task는 읽기/보관의 완료로 승격하지 않는다. Outcome이 저장됐더라도 retained worktree owner는 별도 상태이며 document audit의 complete는 cleanup/실행 권한을 부여하지 않는다. Binding 생성 전 중단은 typed proof 없이 explicit legacy-unbound 부분 coverage만 제공한다. [실제 7개 SIGKILL 경계와 한계](engine-goal-verification.md)를 따른다.
