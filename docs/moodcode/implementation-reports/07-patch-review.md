# 07 — Patch · checkpoint · review 구현 결과

2026-10-04, Asia/Seoul. 담당 경로의 실제 구현과 로컬 검증을 완료했다. 공통 contracts/ports, package 설정, facade/public exports 및 다른 담당 구현은 수정하지 않았다. dependency 설치·git 변경 명령·외부 공급자 호출을 수행하지 않았다.

## 파일과 export

- `packages/engine/src/tools/patch/index.ts`: `createPatchTool(): ToolDefinition`, tool name `apply_patch`.
- `packages/engine/src/tools/patch/index.test.ts`: patch 단위·filesystem·잠금 회귀 테스트 21개.
- `packages/engine/src/tools/patch/review-integration.test.ts`: 실제 SQLite 저장·재시작·부분 실패 diff·복원 통합 테스트 1개.
- `packages/engine/src/review/index.ts`: 동기 `getReviewDiff(store, runId): ReviewDiff`, 비동기 `restoreCheckpoint(store, workspace, checkpointId): Promise<RestoreResult>`.
- `packages/engine/src/review/index.test.ts`: review·restore 회귀 테스트 22개.

`RestoreResult`는 `{checkpointId, restored: string[], conflicts: {path, reason}[], failed: {path, error, mayHaveChanged}[], warnings: string[]}`다. 복원은 service API만 제공하며 공개 engine command를 추가하지 않았다.

## 구현된 동작

Patch는 `{changes: [{path, expectedHash: string|null, content: string|null}]}`의 full-content replacement만 받는다. `expectedHash=null`은 부재, `content=null`은 삭제다. create/update/delete, SHA-256 preimage 검사, 순수 prepare와 bounded readable preview를 구현했다. unified patch parser는 포함하지 않는다.

변경 수 최대 32개, 상대 경로 최대 UTF-8 512 bytes, 파일 이미지 각 1 MiB, preimage와 replacement 합계 4 MiB다. 잘못된 shape·hash·UTF-8·NUL, 중복/case alias·경로 중첩, 절대/drive/backslash/탈출 경로, `.git`·`node_modules`, symlink·nonregular·hardlink를 거절한다. approval preview는 모든 대상과 전후 hash/byte/operation을 포함하고 전체 JSON UTF-8 32 KiB 이하다. 미리보기의 본문은 파일당 앞 8줄·줄당 160자로 제한한다. 대상 메타데이터만으로 한도를 넘으면 더 작은 batch를 요구하는 오류를 반환한다.

Fingerprint는 정확한 정규화 입력, canonical workspace root/ID, session/run/tool ID, execution lock path에 결합한다. `requiresApproval=true`를 항상 반환한다. 실제 승인 부여·승인 record 검사는 coordinator 책임이며, tool은 자신이 생성한 PreparedTool의 input/fingerprint/preview/context 변경을 재검증한다. WeakMap으로 준비 시 preimage와 파일 identity를 보관하며 준비 객체는 1회만 실행된다. 준비 객체를 직렬화·복제해 나중에 재실행하는 기능은 없다.

실행은 모든 대상의 현재 경로·hash·파일 identity를 첫 효과 전에 검사하고 각 대상 직전에도 재검사한다. 기존 파일 FD를 `O_NOFOLLOW`로 열고 descriptor/path identity와 읽기 전후 size/mtime/ctime를 확인한다. 새 파일은 exclusive create로 이미 생긴 사용자 파일을 덮어쓰지 않는다. 필요한 parent directory는 승인 후 생성하며 각 mkdir 사이에도 취소를 확인한다. 이전부터 있던 사용자 변경을 preimage로 기록하고 unrelated 파일은 수정·diff에 포함하지 않는다.

`ToolContext.executionLockPath`가 주어지면 공통 `acquireExecutionLock`을 효과 직전에 획득해 파일 변경·postimage 수집·checkpoint persist까지 유지한다. 활성 command supervisor는 `COMMAND_EFFECTS_BUSY`, 종료 여부가 미확정인 durable marker는 `COMMAND_CLEANUP_UNCERTAIN`으로 새 patch 효과를 막는다. 정상적으로 기록한 부분 실패도 효과가 정리된 뒤 잠금을 해제한다. checkpoint persist 실패는 `PATCH_CHECKPOINT_FAILED`를 반환하고 active marker를 남겨 후속 효과를 차단한다. lock path를 prepare와 execute 사이에 제거/변경할 수 없다.

도중 오류·취소 시 이미 만든 효과를 자동 rollback하지 않는다. 시도한 파일의 실제 생존 postimage와 원래 preimage를 checkpoint에 기록하고 `incomplete`·경고·`isError`를 반환한다. 효과 전 발견한 외부 편집은 patch 변경 기록에서 제외한다. postimage 수집 실패도 성공으로 표시하지 않는다. 생성한 directory는 내용 복원이 제거하지 않는다는 경고를 남긴다. 취소 후에도 효과 accounting은 완료하고, 모델에 전달하는 짧은 결과는 `maxOutputBytes`를 지킨다.

Review는 patch·command checkpoint의 전후 이미지를 검증하고 연속 hash/content chain만 병합한다. 외부 편집 또는 누락 관찰로 chain이 끊기면 같은 경로의 별도 diff segment와 경고를 반환한다. Git 전체 working-tree diff를 복사하지 않는다. command의 관찰 한계·incomplete capture·잘못된 이미지 hash를 경고한다. history checkpoint, 반환 merged diff, warning 및 metadata에 합계 64 MiB UTF-8 accounting 제한을 적용하며 checkpoint/관찰 파일/조회 tool 수에 50,000개 한도가 있다.

중단된 `apply_patch`/`run_command`가 checkpoint를 기록하지 못했거나, 실행 중/중단된 도구의 출력이 아직 미확정이면 `effects may exist outside recorded checkpoints` 경고를 반환한다. 따라서 crash 직후 `files: []`를 실제 filesystem 효과가 없다는 의미로 표시하지 않는다. 완료된 no-op, 읽기 도구, 다른 Run의 도구는 이 경고를 만들지 않는다.

Restore는 store의 workspace identity와 checkpoint 소유 Run을 확인하고 모든 대상의 postimage hash를 먼저 검사한다. 파일 실행 직전에도 postimage·경로·descriptor identity를 재검사하며, 외부 편집이 있으면 conflict로 보존한다. 독립적으로 안전한 파일은 복원하고 쓰기 권한 오류·늦은 쓰기 실패는 `failed`/`mayHaveChanged`에 남긴다. checkpoint 조회는 workspace session/run을 순회하며 session 1,000개·Run 10,000개·checkpoint 50,000개 한도가 있다. 복원 자체는 파일 2,048개·각 이미지 16 MiB·전후 이미지 합계 32 MiB다.

## 실제 검증

macOS, Node `v26.9.0`, root가 설치한 tsx/TypeScript를 사용했다. 마지막 담당 테스트 실행 결과는 **44 passed / 0 failed / 0 skipped**다.

```sh
./node_modules/.bin/tsx --test packages/engine/src/tools/patch/index.test.ts packages/engine/src/tools/patch/review-integration.test.ts packages/engine/src/review/index.test.ts
```

담당 파일 strict TypeScript 검사는 **exit 0**, diagnostics 없음이다.

```sh
./node_modules/.bin/tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/tools/patch/index.ts packages/engine/src/tools/patch/index.test.ts packages/engine/src/tools/patch/review-integration.test.ts packages/engine/src/review/index.ts packages/engine/src/review/index.test.ts
```

테스트는 실제 임시 파일과 symlink/hardlink, stale preimage 및 prepared approval 변조, batch 전체 재검증, 실행 중 외부 편집, 취소 전/후 및 mkdir 중 취소, no-op, byte/count/preview limits, update mode 보존, 실제 chmod permission failure, deterministic truncate/postimage-read/partial UTF-8-write failures를 검증한다. durable execution lock의 동시 효과 차단·checkpoint 기록 중 유지·기록 실패 후 active marker·lock binding도 검증했다. crash-gap 경고와 aggregate review 제한을 포함한다.

SQLite 통합 테스트는 실제 patch 도중 truncate 실패로 남은 내용을 immutable checkpoint에 저장하고 DB를 닫았다 다시 열어 동일한 review를 확인했다. 해당 checkpoint를 복원해 기존 사용자 수정 내용과 무관한 사용자 파일을 보존하고 patch가 만든 파일을 제거했다. 단위 테스트의 fake 저장소만으로 검증한 결과가 아니다.

## 한계와 계약 제안

- Node 경로 API에는 원자적인 `openat`/directory lease/content compare-and-write가 없다. 단계별 재검증은 정상적인 stale 파일/승인을 막지만 악의적인 동시 parent/path 교체나 마지막 검사와 효과 사이 외부 쓰기의 모든 race를 제거하지 못한다. restore caller는 workspace 효과와 직렬화해야 한다.
- 현재 checkpoint는 UTF-8 문자열 내용만 표현한다. 중간 byte 쓰기 실패로 UTF-8이 깨지면 그 postimage를 정직하게 표현할 수 없어 해당 파일은 `incomplete` 경고와 함께 누락된다. 테스트로 이 경우를 확인했다. raw byte artifact/hash 참조를 지원하는 checkpoint shape가 필요하며 자동 복원이 가능하다고 표시하지 않는다.
- 파일 효과와 checkpoint DB commit은 원자적이지 않다. 실제 프로세스 손실로 checkpoint 없는 효과가 남을 수 있다. durable marker와 unresolved-tool warning은 이를 차단/표시하지만 잃은 preimage를 재구성하지 않는다. 향후 효과 전 immutable intent/preimage 기록 또는 artifact journaling port를 제안한다.
- 복원은 파일 내용만 되돌린다. 생성된 directory, mode/소유권, arbitrary command의 process·binary·외부 효과는 복구하지 않는다. 삭제 파일을 다시 만들 때 mode는 `0600`이다.
- optional execution lock를 제공하지 않는 직접 tool caller는 별도로 효과를 직렬화해야 한다. Engine facade는 현재 context에 lock path를 전달한다. restore는 lock path를 받는 계약이 없어 호출자 직렬화가 필요하다.
- `EngineStore.getCheckpoint(workspaceId, checkpointId)`와 paged checkpoint/tool 조회 port를 제안한다. 현 store API는 배열/전체 session snapshot을 먼저 반환하므로 구현의 합계 accounting은 받아온 history의 이후 처리를 제한하며 DB fetch 자체를 streaming memory bound로 만들지는 못한다. 합계 UTF-8 accounting은 JSON escape 확장 후 wire byte 수와 동일한 한도가 아니다.
- 전체 monorepo build, root E2E suite, Node 24/Windows/Electron runtime, 외부 공급자는 이 담당 세션에서 실행하지 않았다. 공통 빌드와 runtime 검증은 통합 담당 범위다.

## 추가 단계 — 복원 미리보기 · 공유 잠금 · 취소

사용자의 추가 병렬 작업 지시에 따라 같은 소유 범위에서 복원 service를 보완했다. 이번 추가 변경은 `review/index.ts`, `review/index.test.ts`, 신규 `review/restore.integration.test.ts`, 이 보고서뿐이다. root ports/contracts/facade/public exports 및 다른 담당 경로는 수정하지 않았다.

`restoreCheckpoint(store, workspace, checkpointId, options?: RestoreOptions)`는 기존 3인수 호출과 호환된다. `RestoreOptions`는 `{executionLockPath?: string, signal?: AbortSignal, previewFingerprint?: string}`다. `previewFingerprint`는 선택적으로 readonly 미리보기와 이후 실행의 대상·현재 상태를 연결한다.

새 export `previewRestoreCheckpoint(store, workspace, checkpointId, options?): Promise<RestorePreview>`는 checkpoint/workspace ID, fingerprint, 파일별 복원 operation/create/update/delete/noop·기록 postimage hash·복원 preimage hash·현재 hash·ready/conflict/failed·이유, 활성 Run ID, 가능 여부, 한도와 전후 이미지 합계 bytes, 부분 capture/command 범위 경고를 반환한다. 파일·DB journal·execution lock DB를 쓰지 않는다. lock path를 제공해도 readonly preview가 lock DB를 만들거나 active marker를 변경하지 않는다. 미리보기 후 shared lock을 추가하는 것은 대상 fingerprint를 바꾸지 않는다.

실행은 workspace의 모든 세션 Run을 확인하고 `created`/`running`/`awaiting_approval`/`cancelling`이 있으면 `RESTORE_WORKSPACE_BUSY`로 효과 전에 거절한다. async preflight 후, 잠금 획득 후, create/update/delete 직전에도 다시 확인한다. `previewFingerprint`를 제공하면 shared lock 획득 뒤 현재 파일 hash와 identity를 다시 관찰해 비교하고 달라지면 `RESTORE_PREVIEW_STALE`로 batch 전체의 효과를 막는다. 이후 각 파일 guard에서도 preflight identity를 비교하므로 fingerprint 재확인 뒤 같은 내용의 다른 inode로 교체된 파일을 덮어쓰지 않는다.

`RestoreResult`에는 원래 필드와 함께 `cancelled`, `observations[{path,state:present|absent|unobserved,currentHash?,bytes?,error?}]`, `effectsUncertain`, `executionBlocked`를 추가했다. 시작한 filesystem I/O를 끝까지 기다리고 handle close와 post-effect accounting 동안 shared execution lock을 유지한다. observations는 raw byte SHA-256을 사용하므로 부분 쓰기로 UTF-8이 깨진 상태도 hash와 byte 수로 관찰할 수 있다. 문자열 content checkpoint가 그 raw 상태를 복구할 수 있다는 뜻은 아니다.

취소를 효과 전에 확인하면 `CANCELLED` 오류와 함께 아무 복원 효과도 만들지 않는다. 도중 취소하면 남은 파일을 중단하고 `cancelled=true`와 완료/부분 효과의 observed state를 반환한다. accounting 동안에는 AbortSignal을 수집 중단에 사용하지 않으며, accounting 중 도착한 취소도 완료된 효과를 유지하고 반환 상태에 표시한다. 실패·취소 후 자동 rollback하지 않는다.

잠금 marker 정책은 다음과 같다. 이미 시작한 쓰기가 정리됐고 현재 경로 상태를 관찰할 수 있으면 성공/부분 실패/취소 여부와 관계없이 marker를 해제한다. post-effect 관찰 실패 또는 변경한 파일의 handle close가 미확정이면 `effectsUncertain=true`; shared lock이 있을 때는 `executionBlocked=true`와 durable active marker를 남긴다. 재시작 또는 재호출로 그 marker를 자동 제거하지 않는다. 전후 hash가 다른 것으로 확인된 부분 파일만으로 marker를 영구 차단하지 않는다. 복원할 eligible 파일이 없어도 지정한 lock의 기존 quarantine marker는 확인한다.

복원은 파일 2,048개·각 이미지 16 MiB·전후 이미지 합계 32 MiB에 더해 checkpoint metadata 4 MiB를 제한한다. 잘못된 UTF-16 문자열의 대체 인코딩으로 파일명/내용이 바뀌는 경우도 거절한다.

추가 한계/통합 제안: root가 `previewRestoreCheckpoint` 및 관련 타입을 public service exports에 연결할 수 있으나 공개 restore command는 이번에 추가하지 않았다. 실제 engine의 동일한 execution lock path를 options에 전달해야 patch/command/restore 효과가 서로 배제된다. options를 생략하는 이전 호출은 활성 Run·hash/path 검사를 받지만 caller의 효과 직렬화 책임이 남는다. current ports에는 workspace Run admission과 restore lease를 원자적으로 결합하는 기능이 없어 snapshot 검사와 효과 사이의 모든 admission race를 봉쇄하지는 못한다. coordinator 참여 lease와 직접 active Run 조회 port를 제안한다.

완료된 Run의 immutable checkpoint를 읽는 service이며 복원 결과를 새 journal row로 저장하지 않는다. 결과의 observations는 호출자에게 반환된다. durable restore operation/intent/result 기록을 위한 별도 store port가 필요하다. 파일 효과·DB journal 원자성, directory/mode/owner/process 복원, Node 경로 TOCTOU 한계는 앞 단계와 같다.

### 추가 단계 실제 검증

macOS / Node `v26.9.0`에서 마지막 담당 테스트는 source와 compiled JavaScript 모두 **68 passed / 0 failed / 0 skipped**다. 구성은 patch 21개, partial patch→SQLite reopen→review→restore 1개, review/restore 단위 25개, 실제 SQLite restore 통합 21개다.

```sh
./node_modules/.bin/tsx --test packages/engine/src/tools/patch/index.test.ts packages/engine/src/tools/patch/review-integration.test.ts packages/engine/src/review/index.test.ts packages/engine/src/review/restore.integration.test.ts
```

담당 6개 source/test entry를 `tsc --ignoreConfig`, `NodeNext`, `ES2023`, `--strict`, `--noUncheckedIndexedAccess`, `--types node`로 engine source `rootDir`와 별도 임시 `outDir`에 compile했다. 결과 **exit 0**, diagnostics 없음이다. 그 출력의 4개 `.test.js`를 실제 `node --test`로 실행해 같은 68개 테스트가 통과했다. Python `TemporaryDirectory`가 검증 출력만 관리·정리했으며 monorepo 설정/dist/build scripts는 수정하지 않았다.

SQLite 통합은 다른 세션의 모든 활성 Run 상태, 최종 writable guard 중 새 Run admission, lock busy/orphan active marker/reopen, preview 이후 외부 편집, 동일 내용의 inode 교체(호출 전 및 fingerprint 재검증 후), 수정/생성/삭제 복원과 기존 3인수 호환성을 확인했다. post-effect accounting 종료까지 잠금 유지, 실제 pending write 중 취소, 관찰 중 취소, known partial failure 후 marker 해제, postimage 관찰 실패/쓰기 handle close 불확실성 후 durable block을 검증했다. 미리보기는 지정한 lock DB를 만들지 않고 partial capture/command 한도·현재 hash·충돌을 표시하는지 확인했다.

전체 monorepo/harness/Electron 검증은 통합 담당에게 남겼다. 이번 단계도 dependency 설치·외부 공급자 호출·root API 변경·공개 복원 command 노출을 수행하지 않았다.
