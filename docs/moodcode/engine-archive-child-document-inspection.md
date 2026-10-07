# 아카이브의 historical child 문서 조회

`inspectArchivedChildDocumentStorage`는 닫힌 아카이브에서 명시적으로 선택한 child의 검증된 문서 메타데이터를 반환하는 standalone host API다. 살아 있는 MoodcodeEngine이나 원래 저장소를 열지 않는다. [archive](engine-archive.md)와 [managed child 저장 계약](engine-child-document-storage.md)을 따르며 완료 검증·source commit은 [최신 보고서](engine-goal-verification.md)를 기준으로 한다.

```ts
import { inspectArchivedChildDocumentStorage } from '@moodcode/engine';

const report = await inspectArchivedChildDocumentStorage({
  directory: archive.directory,
  expectedManifestSha256: archive.manifestSha256,
  sessionId,
  sourceRunId: originalRootRunId,
  taskIds: [completedChild.id],
  signal,
  limits: { maxDocumentSamples: 16, maxReportBytes: 32_768 },
});
```

## 정확한 과거 선택

directory는 절대·정규화 경로이고 expectedManifestSha256는 필수 lowercase SHA-256이다. sessionId·sourceRunId와 중복 없는 dense taskIds를 함께 지정한다. Proxy·accessor·unknown field·잘못된 owner ID·sparse 배열·상한 초과는 archive 접근 전에 거절한다. 요청값과 limits를 복사·동결하여 async 진입 뒤 caller의 selector 변경이 선택을 바꾸지 않는다.

최초 manifest digest가 다르면 DB나 selected index 본문을 읽지 않는다. Root Run/session/workspace의 native/payload owner와 정확한 root task journal은 bounded SQL boolean으로 먼저 확인한다. Missing task나 다른 root lineage도 index proof 본문 전에 거절한다. SQLite 내부 JSON 검사 자체의 CPU·전체 row allocation을 작은 boolean의 byte budget과 동일하게 취급하지 않는다.

선택 후에는 기존 archive validation을 모두 수행한다. 파일 bytes/SHA·논리 DB/integrity·review·primary/child owner·document refs/blob·manifest allowlist의 기존 계약을 유지한다. 요청하지 않은 child도 전체 archive audit의 검증 대상이다. 검증 중 읽은 selected child index를 같은 frame의 collector로 수집하며 report를 위해 다시 읽거나 새로운 예산을 만들지 않는다. 마지막 manifest SHA도 다시 확인한 뒤 detached 결과를 반환한다.

## 서로 다른 상한

요청 task cap은 기본 8개, 명시적 hard cap 32개다. 전체 archive child proof cap은 별도로 32개다. 예를 들어 child 11개가 보관된 archive에서 1개를 선택하면 11개 audit proof를 검증하고 1개의 메타데이터만 표시한다. 빈 taskIds도 root owner와 전체 archive를 검증하지만 child 상세를 반환하지 않는다.

8MiB metadata·2,048 refs·8,192 charged rows는 owner/task preflight와 primary 및 전체 verified child의 공유 JSON proof 예산이다. Host가 줄인 budget으로 전체 proof를 끝내지 못하면 typed 오류로 거절한다. 미검증 archive를 성공한 partial 보고서로 표시하거나 helper default budget으로 되돌아가지 않는다.

전체 archive 파일 hashing·DB logical hashing/integrity·SQLite 내부 탐색은 이 JSON proof 예산 밖이다. 파일당 256MiB·전체 archive 512MiB·manifest 4MiB, private child mirror 파일당 32MiB·operation 합계 256MiB도 적용한다. Report의 `statsScope:'whole-archive-proof-frame'`는 selected child만의 비용이나 모든 filesystem I/O가 아니다. Physical read/allocated bytes는 `null`이다.

문서 metadata samples는 모든 selected child를 합쳐 기본 16개, 명시적 최대 128개이고 요청 순서를 따른다. `maxDocumentSamples:0`은 명시적 counts-only 조회다. 문서의 id·kind·MIME·declared bytes·SHA만 반환하며 PDF bytes·원본 절대 경로·raw index/binding·credential은 반환하지 않는다. Report JSON은 기본/최대 32KiB, 최소 4KiB다. 초과하면 metadata samples부터 줄이고 그다음 child 상세를 생략한다. 검증된 counts와 알려진 부분합은 보존한다.

Deadline 기본/최대 2초는 fs/SQL 경계에서 검사한다. 최초 async yield 뒤 구현은 동기 검사를 수행하므로 event loop의 새로운 타이머 callback이 중간에 실행된다는 보장은 없다. OS 호출을 강제로 중단하거나 모든 작업을 2초 안에 끝내는 기능은 아니다. 유효한 native AbortSignal을 operation 수명에 연결하고 완료·오류 뒤 관측을 해제한다. Caller의 공개 signal property 변경이 operation의 취소 관측을 덮어쓰지 못하도록 actual runtime 경계를 검증한다.

취소 보장은 검증 시 제공된 signal의 native 상태와 관측을 연결한 뒤의 controller 취소를 대상으로 한다. 실제 Node 26.9.0에서 관측되지 않던 composite의 부모를 먼저 취소한 뒤 그 부모의 공개 상태를 가린 경우, 제공된 composite의 native getter 자체도 false였다. 이미 가려진 ancestry의 과거 취소를 Node 내부 private graph에서 재구성하지 않는다. 정상 composite와 진입 뒤 parent 취소는 active private observer로 확인한다.

## 완료와 unknown

`complete`는 선택한 child index와 표시할 samples의 완료다. 검증된 counts를 모두 알더라도 samples나 child 상세를 생략하면 false다. Counts-only에서 refs가 존재하면 생략을 표시하고 complete를 false로 둔다. `documentsOmitted`·`observedDocumentsOmitted`·`reportsOmitted`·reasons를 함께 읽는다.

`archiveCoverage`는 전체 archive audit의 complete/partial/unchecked다. Legacy ancestor 때문에 archive가 partial이어도 정확히 verified된 grandchild의 선택 보고서는 complete일 수 있다. 반대로 전체 audit이 complete여도 sample cap 때문에 선택 표시가 incomplete일 수 있다. 원래 binding 없는 legacy 및 archive에 포함되지 않은 external child는 unchecked로 남고 알 수 없는 totals는 `null`이다. 알려진 child 부분합은 `declaredReferenceBytes.observedChildSubtotal`이다. 동일 document ID를 다른 archived child store의 소유권과 합치지 않는다.

역사적 child session/Run·root/parent lineage를 표시하지만 현재 host의 physical ownership을 재발급하지 않는다. `physicalRebinding`, `recoveryAcknowledgmentsRebound`, `executionResumed`는 모두 false다. Provider·recovery·ACK·import·cleanup·worktree release를 실행하지 않는다. Import된 typed child의 fresh-source 재-export 제한도 그대로 유지하며 이 API는 원래 exact archive를 읽는다.
