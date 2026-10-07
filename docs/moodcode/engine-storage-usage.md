# 엔진 저장소 크기 진단

`inspectEngineStorage({artifactDir, dbPath?, signal?, limits?, imageIndex?})`는 파일 내용을 읽거나 파일을 바꾸지 않는 비동기 메타데이터 검사다. `artifactDir`와 지정한 `dbPath`는 절대 경로이며 정규화된 경로여야 한다. 기존 조상 디렉터리를 포함해 symlink가 있으면 그 경로를 검사하지 않는다. 실제 host 연결은 일반 모델 턴과 분리해 호출해야 한다.

```ts
const report = await inspectEngineStorage({
  artifactDir: canonicalArtifactDirectory,
  dbPath: canonicalDatabasePath,
  signal,
  imageIndex: store.inspectInputImageIndex(),
  limits: { maxEntries: 10_000, maxDurationMs: 2_000 },
});
```

실제 engine host는 `await engine.getStorageUsage({signal, limits})`로 호출한다. canonical artifact/DB 경로와 주 DB image index는 엔진이 공급하며 호출자가 교체하지 못한다. 반환은 `StorageUsageReport` 하나이며 `maxReportBytes`는 전체 JSON에 적용된다. 상세 SQL index는 `engine.store.inspectInputImageIndex()`로 별도로 읽는다. 이 함수는 문서 최대 64개·참조 2,048개·JSON 4MiB를 검사하며 owner/version/ref가 손상됐거나 일부만 읽었으면 `complete:false`다. 주 DB 상태를 파일 정리 권한으로 바꾸지 않는다.

일반 model turn, `session.getDiagnostics`, capability 조회는 filesystem scan을 시작하지 않는다. host close는 실행 중인 검사를 취소하고 열린 directory/handle이 정리될 때까지 기다린다. SQL index 단계 이전 취소는 `CANCELLED`, scan 중 취소는 `stopReasons`에 `aborted`가 포함된 불완전 보고서로 나타난다. 닫힌 엔진의 신규 검사는 `ENGINE_CLOSED`다.

## 크기가 뜻하는 것

`logicalPathBytes`는 각각 재검증을 통과한 regular file **경로**의 `lstat.size` 합계다. sparse file, 압축, 파일시스템 블록, 스냅샷, 열린 채 삭제된 파일, 용량 예약을 확인하지 않는다. `physicalAllocatedBytes`는 항상 `null`이다.

`uniqueObservedInodeBytes`는 이 검사에서 관찰한 `(dev, ino)`가 처음 등장했을 때의 크기만 합산한다. 같은 inode를 가리키는 다른 경로는 `duplicateInodePaths`에 집계한다. `nlink > 1`인 파일은 `hardlinkedFiles`에도 집계하지만, 범위 밖의 다른 hardlink 경로는 찾지 않는다. 이 값도 물리 디스크 점유량이 아니다. 같은 inode의 서로 다른 크기를 관찰하면 불완전한 검사로 표시한다.

그룹은 `artifactDir`의 첫 경로 요소 기준 `managed`, `input-media`, `input-documents`, `children`, `terminals`, `other`다. `terminals.sqlite`, `terminals.sqlite-wal`, `terminals.sqlite-shm`도 `terminals`에 속한다. 명시적으로 지정한 DB 본체와 `-wal`, `-shm`은 `database` 그룹에 속하고 DB가 artifact 디렉터리 내부에 있으면 같은 경로를 두 번 합산하지 않는다. SQLite를 열거나 쿼리하지 않는다. DB 본체가 없으면 불완전한 검사이고, 선택적 WAL/SHM 부재는 오류가 아니다. artifact 디렉터리 밖의 effect/review DB, 별도로 설정한 worktree 디렉터리 및 기타 저장소는 자동으로 찾지 않는다.

`regularFiles`/`observedRegularFiles`는 최초 regular-file 관찰 수다. `stableFiles` 및 크기 합계는 inode·크기·mtime·ctime·link count 재검증과 조상 경로 검증을 통과한 파일에만 적용한다. `directories`, `symlinks`, `specialFiles`, `changedEntries`, `errors`는 그룹별 관찰 수다. 내용은 읽지 않으므로 파일 형식·hash·DB 일관성·credential 존재를 검증하지 않는다.

## 제한과 불완전한 범위

| 제한 | 기본값 | 허용 범위 |
| --- | ---: | ---: |
| `maxEntries` | 10,000 | 1–100,000 |
| `maxDirectories` | 1,024 | 1–10,000 |
| `maxDepth` | 12 | 0–32 |
| `maxDurationMs` | 2,000 | 1–30,000 |
| `maxOperations` | 100,000 | 1–1,000,000 |
| `maxSamples` | 64 | 0–256 |
| `maxSamplePathBytes` | 256 | 32–2,048 |
| `maxReportBytes` | 32,768 | 4,096–131,072 |
| `maxImageIds` | 2,048 | 1–65,536 |
| `maxDocumentIds` | 2,048 | 1–65,536 |

루트 깊이는 0이며 루트 자체도 entry와 directory 상한에 포함한다. 깊이 상한에 도달한 디렉터리는 내용을 열거하지 않으며, 비어 있는지를 추정하지 않고 `depth_limit`로 표시한다. `opendir({bufferSize: 1})`에서 한 항목씩 읽어 디렉터리 전체 목록을 메모리에 올리지 않는다. operation 상한은 검사기가 직접 호출한 메타데이터·열거 API 횟수이며 kernel syscall 수를 뜻하지 않는다. 제한과 취소를 맞았을 때 열린 디렉터리와 읽기 전용 directory handle을 모두 닫은 후 결과를 반환한다.

`complete`는 지정한 범위의 열거와 해당 파일 재검증이 제한·오류·관찰된 교체 없이 끝났다는 뜻이다. symlink나 special file을 건너뛰었거나 검사 경로·파일·디렉터리가 바뀌면 `false`다. symlink의 대상을 따라가거나 FIFO/socket/device의 내용을 열지 않는다. `stopReasons`는 모든 불완전 사유를 중복 없이 담고 `stopReason`은 전체 중단이 있으면 그 사유, 그렇지 않으면 첫 불완전 사유다. 미검사 항목 개수는 알 수 없으므로 `unvisitedEntries: null`로 표시한다. `skippedDepthDirectories`는 관찰한 깊이 제한 디렉터리 수만 나타낸다.

시간과 취소는 파일시스템 호출 전후의 **협력적 검사**다. 이미 실행 중인 파일시스템 작업이나 handle 정리를 강제 중단하지 않으므로 `maxDurationMs` 안에 반드시 응답한다는 보장은 없다. `elapsedMs`는 정리까지 포함한 실제 관찰 시간이다.

열거 중 디렉터리 inode를 읽기 전용 `O_NOFOLLOW` handle로 고정하고 각 단계에서 조상 경로와 현재 inode를 확인한다. 파일은 내용을 열지 않고 `lstat`를 반복한다. macOS Node에서 directory FD를 전달하는 `opendir`를 사용할 수 없어 열거는 여전히 경로 기반이다. 이 API는 원자 스냅샷이나 적대적인 모든 경로 race를 차단하는 파일시스템 sandbox가 아니다. 검사 후 파일 변경, 탐지 사이의 교체 후 복원, inode 재사용은 증명하지 않는다. `coverage.snapshot`과 `pathRaceIsolation`이 이 한계를 명시한다. Linux/Windows 실제 동작은 이 macOS 검증의 증거에 포함하지 않는다.

샘플은 절대 루트를 포함하지 않는 상대 경로이며, 개수·경로 UTF-8 바이트·전체 JSON 바이트 상한을 적용한다. 파일·디렉터리·skip/error 샘플은 하나의 공용 상한을 사용하므로 샘플에 없는 경로가 없었다는 뜻이 아니다. `samplesOmitted`, `candidatesOmitted`, `reportTruncated`로 샘플 누락을 표시하고 그룹의 관찰 합계는 유지한다. 파일 이름 자체는 보일 수 있지만 파일 내용·환경 변수·credential 값·raw image bytes는 조회하지 않는다.

## 이미지 orphan 후보

`imageIndex`는 host가 같은 **주 DB**의 모든 `session_documents.input_images`를 읽기 전용으로 검사한 결과여야 한다. 필요한 구조는 `scope: 'primary-database-only'`, `observedAt`, `complete`, `imageIds`다. storage의 전체 report를 그대로 전달할 수 있다. 목록이 없거나 불완전하거나 scope/ID/시각이 잘못됐거나 ID 상한을 넘으면 후보를 만들지 않는다. 검사기는 caller가 주장한 provenance를 독립적으로 증명하지 않으므로 외부 클라이언트가 임의 index를 제출하게 해서는 안 된다.

완전한 index에서 참조되지 않는 `artifactDir/input-media/img_<32자리 소문자 hex>.blob` regular file만 후보가 된다. `nlink !== 1`인 blob, staging 파일 `.pending_img_…`, 임의 이름, nested 디렉터리, child 저장소의 이미지 파일은 후보에서 제외한다. 후보의 `candidateFiles`/`candidateBytes`는 이번 검사에서 관찰한 수와 논리 크기이며, 전체 scan이 불완전하면 후보 목록의 coverage도 불완전하다. 두 index와 파일 관찰 시각은 서로 다르고 import의 publish→DB CAS 사이에도 후보가 생길 수 있다.

이는 **주 DB index snapshot에서 참조되지 않았다는 관찰**이다. active import, child DB, 과거 snapshot, host 정책을 모두 확인한 삭제 허가가 아니다. 생성한 파일 이름과 링크 수만으로 생성 주체를 증명하지 않으며, 손상 여부·실제 이미지 내용·hash도 읽지 않는다. `deletionPerformed: false`, `cleanup: 'not-performed'`이며 삭제·prune·복구·성공적인 cleanup을 수행하거나 주장하지 않는다.

## 검증 증거

실제 macOS 임시 디렉터리 fixture로 그룹별 논리 크기, DB sidecar/내부 경로 중복, hardlink 중복, symlink와 FIFO skip, root/조상 symlink 거부, 완전/불완전 이미지 index와 후보 제한, entry/directory/operation/depth/time/cancel 상한, 파일 크기·inode 교체, 디렉터리 symlink 교체·열거 후 파일 추가, UTF-8 sample/JSON 상한 및 invalid/missing scope를 검증한다. 시간과 교체 fixture는 실제 파일시스템 작업에 내부 scheduling hook을 사용해 변경 지점을 고정한다. 이 hook은 production entrypoint 옵션이나 package barrel로 노출하지 않는다. 실제 filesystem allocated bytes, 파일 내용 검사, live credential, Linux/Windows, 강한 race isolation은 검증 범위에 없다.

## PDF index 관측

`getStorageUsage()`는 `input_documents`의 주 DB CAS index를 별도 bounded 조회하고 scanner의 `documentIndex`로 전달한다. report의 `documents`는 `images`와 병렬이며 `root-input-documents-only` coverage·관측 시각·완전성·candidate 목록을 갖는다. `input-documents/doc_<32hex>.blob`의 primary snapshot 미참조 regular single-link 파일만 후보가 된다. 동일 JSON/report cap을 공유하며 staging·symlink·임의 이름·child 내부 index는 검사된 orphan으로 간주하지 않는다. 자동 삭제하지 않고 publish→CAS race를 같은 제한으로 표시한다. [문서 입력 계약](engine-input-documents.md)을 따른다.
