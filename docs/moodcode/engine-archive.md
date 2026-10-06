# 전체 엔진 archive

`exportEngineArchive({dbPath,artifactDir,destination,signal?})`는 닫힌 persistent engine의 primary·review·존재하는 recovery ledger/effect DB와 artifact tree를 함께 보존한다. source primary/review owner lease, effect lease, 각 source write lease를 한 번에 유지하고 stable snapshot을 캡처한다. 실행 중 owner는 `RECOVERY_OWNER_BUSY`, active effect marker는 `ARCHIVE_EFFECT_ACTIVE`로 거부한다. marker를 임의로 지우거나 효과 실행을 취소 완료로 기록하지 않는다.

새 destination만 사용한다. private staging에 standalone DELETE-mode SQLite backup과 artifact를 만들고 record/hash/schema/SQLite integrity를 검증한다. UTF-8 manifest는 version 1, archive ID/time, 원본 DB·review·artifact inode binding/scope, 파일 bytes/SHA-256, DB schema version/logical hash를 포함한다. review의 unresolved operation은 primary의 terminal Run/checkpoint/session/workspace와도 검증한다. artifact는 symlink·hardlink·special file을 거부하고 chunk별 inode·size·mtime·ctime를 확인한 뒤 전체 파일 목록/hash를 다시 확인한다.

publication은 새 private destination container를 독점 생성하고 완성된 payload를 `destination/data`로 atomic rename한다. 반환값은 `{directory,manifest,manifestSha256}`다. `validateEngineArchive({directory,signal?})`는 파일·manifest·논리 DB 내용·review binding을 다시 확인한다. SQLite WAL/SHM을 archive source에 생성하는 validation을 피하기 위해 standalone header를 먼저 확인한다.

`importEngineArchive({directory,destination,signal?})`는 archive를 검증한 뒤 또 다른 새 bundle로 복사한다. source와 기존 destination은 덮지 않는다. 필요하면 staged primary에 순차 migration을 적용하고 모든 session을 `recovery_required`로 pause한다. 실제 provider dispatch·Part prefix·pending Input·원래 v1 journal은 유지하며 import 자체는 실행이나 자동 재시도를 하지 않는다. `import.json`에는 원본 manifest hash와 migration/pause 결과를 기록한다. 반환값에는 `dbPath`, `artifactDir`, `migratedFromVersion`, `schemaVersion`, `sessionsPaused`, `artifactPathMapping`, `executionResumed:false`가 추가된다.

review/ledger의 원본 acknowledgement row와 operation fingerprint는 그대로다. 새 inode의 DB/review/artifact로 원래 acknowledgement를 재연결하지 않는다. manifest에 source binding을 보존하는 것은 출처 기록이며 새 효과를 승인하는 증명이 아니다. 복원 후 불확실한 review/effect는 기존 recovery 절차로 다시 확인해야 한다. 원래 absolute artifact path가 포함된 legacy 기록도 불변이므로 반환된 `{from:oldArtifactDir,to:newArtifactDir}` mapping을 artifact resolver에서 적용해야 한다. workspace 파일은 archive 대상에 포함하지 않는다.

`artifactDir/terminals.sqlite` 같은 닫힌 DELETE-mode journal은 opaque artifact member로 bytes/hash 그대로 보존한다. archive는 그 schema/state를 engine primary로 해석하거나 rewrite하지 않는다. TerminalService와 journal close를 마친 뒤 engine owner lease를 해제하는 순서가 필요하며, 복원된 terminal 세션의 interrupted 판정과 process 재실행 금지는 TerminalService의 책임이다. fixture는 실제 SQLite opaque member의 byte 보존을 검증한다.

제한은 artifact 4096개, 모든 멤버 합계 512MiB, 파일 하나 256MiB, manifest 4MiB, artifact depth 64다. recovery stable snapshot은 별도 기존 512MiB/12 DB-sidecar 제한을 따른다. 정상적인 abort나 오류는 private partial data를 정리하고 모든 lease를 해제한다. 프로세스 강제 종료 시 private staging 또는 비어 있는 publication container가 남을 수 있으므로 archive validation을 통과하지 않은 경로를 실행 데이터로 사용하지 않는다. 일단 publication된 payload는 원자적으로 완성본이다.

Focused fixture는 실제 v1 recovery acknowledgement의 보존과 복사된 authority 0, v1→v2 import, native pending/dispatch/Part prefix 및 explicit uncertain recovery, stopped effect marker, owner 경합, partial cleanup, cancellation, 기존 destination 보존, 미래 schema/hash/path tamper를 검증한다. Unix child를 export staging 및 import publish 직전에 SIGSTOP→SIGKILL한 뒤 lease 해제·원본 event 보존·미완성 payload 미노출·새 bundle 재시도 성공도 확인한다. 해당 2개 signal fixture는 Windows에서 skip한다. 라이브 provider·OS 간 restore·대형 파일 전체 archive throughput은 별도 검증이 필요하다.
