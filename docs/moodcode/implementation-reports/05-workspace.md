# 05 — Workspace·경로·Git 구현 보고서

작성일: 2026-10-04, Asia/Seoul. 담당 범위의 실제 구현과 검증을 완료했다. 공통 contracts/ports, package 설정, 다른 담당 모듈은 수정하지 않았다.

## 구현 파일

- `packages/engine/src/workspace/index.ts`: 공개 workspace API, canonical 경로 검증, Git 상태 파싱, bounded capture.
- `packages/engine/src/workspace/git.ts`: 내부 shell-free Git subprocess runner, timeout·abort·출력 제한·branch 조회.
- `packages/engine/src/workspace/index.test.ts`: 임시 Git 저장소·linked worktree·symlink·파일 캡처·fake Git subprocess 테스트 14개.

## Export API와 통합 기준

```ts
openWorkspace(path: string, options?: GitOperationOptions): Promise<Workspace>
resolveWorkspacePath(workspace: Workspace, relative: string, allowMissing?: boolean): Promise<string>
getGitStatus(workspace: Workspace, options?: GitOperationOptions): Promise<GitStatus>
captureWorkspace(workspace: Workspace, options?: CaptureWorkspaceOptions): Promise<WorkspaceCapture>
```

`index.ts`는 `GitOperationOptions`, `GitStatusEntry`, `GitStatus`, `CaptureWorkspaceOptions`, `WorkspaceCapture`, `DEFAULT_CAPTURE_LIMITS`도 export한다. 고정 `Workspace` 계약과 capture 반환형은 그대로 사용한다. 추가 contracts/ports 변경은 필요 없다.

`GitOperationOptions`는 `{ signal?: AbortSignal; timeoutMs?: number }`다. 기본 timeout은 각 Git subprocess당 10초이고 명시 값은 1~60,000ms 정수다. stdout+stderr 합계 2MiB를 넘으면 중단한다. 상속된 `GIT_*` 환경변수는 repository/config 선택을 바꾸지 못하도록 제거하고 optional index refresh와 fsmonitor/untracked cache를 끈다. shell과 공급자 API를 호출하지 않는다.

`openWorkspace`는 입력 디렉터리와 Git top-level을 `realpath`로 canonicalize한다. `root=gitRoot`이며 `id=workspace_<canonical-root의 전체 SHA-256>`이다. 동일 저장소의 하위 폴더·symlink alias는 같은 ID이고 별도 linked worktree는 다른 ID다. whitespace가 포함된 root는 `.trim()`으로 훼손하지 않는다. unborn branch는 이름을 반환하고 detached HEAD는 `null`이다. non-repository와 bare repository는 작업 트리로 열지 않는다.

`resolveWorkspacePath`는 forward-slash 상대 경로를 받는다. 빈 문자열·`.`은 root다. `..` component, 절대 경로, drive-relative 경로, backslash, NUL을 거절한다. Windows에서는 ADS·reserved device name·종료 dot/space 등 Win32 특수 component도 거절한다. 현재 root가 canonical 경로와 일치하는지 매번 확인하고, 존재하는 component를 `lstat`·`realpath`로 검사한다. 내부 symlink는 실제 내부 경로로 resolve하고 외부·dangling·loop symlink는 거절한다. `allowMissing=true`는 부재 파일·부재 중간 부모를 허용하되 가장 가까운 기존 부모를 확인하며, dangling link를 부재 경로로 취급하지 않는다.

`getGitStatus`는 `{ branch, clean, dirty, entries }`다. entry는 `{path, index, worktree, originalPath?}`다. porcelain v1 `-z`로 공백·newline filename과 rename의 두 NUL pathname을 보존한다. read-only 상태 조회이며 index를 refresh하지 않는다.

`captureWorkspace`는 `{files: Map<relativePath,{content,hash}>, warnings: string[]}`를 반환한다. tracked/untracked/ignored 파일을 루트에서 관찰하고 모든 깊이의 `.git`·`node_modules`를 case-insensitive하게 제외한다. 이 제외 자체는 warning을 만들지 않는다. symlink는 내부·외부 모두 따라가지 않고 warning을 남긴다. nonregular, NUL 포함·invalid UTF-8, oversized, byte budget 초과, 읽기 실패·관찰 중 변경 등은 warning과 함께 제외한다. 정상 디렉터리 항목을 정렬해 traversal 순서를 고정한다. UTF-8 BOM·CRLF·빈 파일을 보존하고 원본 byte에 SHA-256을 계산하므로 content 재인코딩 hash와 일치한다.

기본 capture 제한은 2,000 files / 각 1MiB / 전체 16MiB / 탐색 20,000 entries / 깊이 64다. `{signal, maxFiles, maxFileBytes, maxTotalBytes, maxEntries, maxDepth}`로 조정할 수 있다. 0을 포함한 정수만 허용하고 각 limit에 hard ceiling이 있다. warning은 최대 200개이고 추가 warning은 마지막 항목에 누락을 표시한다. `opendir`로 디렉터리 enumeration 자체도 entry limit으로 제한한다. 파일은 크기 확인 후 descriptor에서 최대 확인된 size+1 bytes만 읽어 growing file이 readFile 메모리 제한을 우회하지 못하도록 한다. 읽기 전후 nanosecond mtime/ctime·size와 bigint inode/device를 비교하고, 최종 상대 경로와 descriptor identity도 재검증한다.

## 실제 검증

실행 환경: macOS, Node `v26.9.0`, Git `2.55.0`, root가 설치한 `tsx`와 TypeScript를 사용했다. dependency 설치·전체 monorepo build는 수행하지 않았다.

```sh
npx --no-install tsx --test packages/engine/src/workspace/index.test.ts
```

최종 결과: **14 passed / 0 failed / 0 skipped**, 약 2.7초. canonical root/identity, nested/alias·unborn·detached·linked worktree, non-directory/non-repo, lexical traversal·absolute/drive/backslash/NUL, missing parent·inward/outward/dangling/loop symlink, root 교체 재검증, modified/untracked/rename/newline 상태, BOM/CRLF/empty/hash round trip, tracked/untracked/ignored·mixed-case exclusion, binary/large/symlink omission, file/byte/entry/depth/warning 한도, pre-abort·시작 후 capture cancel, Git selector 환경변수 isolation을 검증했다. fake local Git으로 stalled process timeout·진행 중 abort·실제 PID 종료·2MiB 출력 제한을 확인했다. fake Node process 시작 latency 때문에 timeout fixture를 300ms에서 2초로 늘렸고 최종 통과했다.

```sh
npx --no-install tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/workspace/index.ts packages/engine/src/workspace/git.ts packages/engine/src/workspace/index.test.ts
```

최종 결과: **exit 0**, diagnostics 없음. 담당 source/test만 strict 타입 검사했다.

## 실제 한계와 후속 통합 시 주의

- 경로 검사와 후속 filesystem 효과 사이의 TOCTOU는 원자적으로 제거하지 못한다. `resolveWorkspacePath`를 effect 직전에 다시 호출해야 한다. POSIX `O_NOFOLLOW`와 descriptor/path 재검증은 capture final component race를 줄이지만 parent component 교체를 잠그지 않는다. 같은 경로의 root directory가 다른 inode로 교체된 경우를 고정 `Workspace` 계약만으로 이전 inode와 비교하지 못한다.
- capture는 bounded observation이며 filesystem 전체의 atomic snapshot이 아니다. 외부 편집·파일 생성/삭제·parent 교체가 관찰 도중 발생할 수 있다. command 전후 capture 차이만으로 변경 원인을 확정하지 못한다. skip/한도 warnings가 있으면 checkpoint가 완전한 전체 복원을 제공한다고 표시하지 않아야 한다.
- entry limit을 넘는 디렉터리는 enumeration 도중 중단하므로 partial subset은 filesystem enumeration 순서에 따라 달라질 수 있다. 일반 완료 capture는 정렬한 traversal 순서를 사용한다.
- UTF-8+NUL 기준은 binary 판별 heuristic이다. 유효한 UTF-8이면서 NUL이 없는 일부 binary format을 모든 경우에 판별하지는 못하며 invalid UTF-8 text도 제외한다. Map key는 Node의 문자열 filename 표현을 사용한다.
- Git timeout/cancel은 직접 실행한 Git child를 SIGKILL로 종료하고 pipe를 닫는다. 임의 descendant process tree의 전면 종료를 보장하지 않는다. 현재 명령은 rev-parse/symbolic-ref/status이며 fsmonitor를 비활성화했다. Git status와 별도 branch 조회는 한 시점의 atomic 결과가 아니다.
- 기본 capture를 초과하는 대규모 workspace·submodule 내부 `.git` 제외 밖의 파일은 일반 recursive 관찰 규칙을 따른다. `.gitignore` 제외는 적용하지 않는다.
- Windows 특수 경로 정책·POSIX symlink 미지원 환경, Node 24, Electron utility process, 전체 monorepo 통합은 여기서 실행 검증하지 않았다. Windows lexical case는 해당 플랫폼에서 테스트하도록 조건화되어 있으며 fake executable 종료 테스트는 Windows에서 skip한다. 실제 provider API·비용 호출은 하지 않았다.

## 추가 단계 — bounded WorkspaceObserver

2026-10-04에 기존 담당 범위에서 polling 기반 관찰 service를 구현했다. 추가 파일은 `packages/engine/src/workspace/observer.ts`, `observer.test.ts`이고 기존 workspace `index.ts`에서 class와 관련 타입을 export한다. root facade·contracts·ports·package 설정은 수정하지 않았다.

공개 API:

```ts
new WorkspaceObserver(workspace: Workspace, options?: WorkspaceObserverOptions)
observer.start(): WorkspaceObserver
observer.stop(): Promise<void>
observer.state: 'idle' | 'running' | 'stopping' | 'stopped' | 'failed'
observer[Symbol.asyncIterator](): AsyncIterableIterator<WorkspaceObservation>
```

처음 `next()`를 호출하면 자동으로 시작하며 `start()`를 먼저 호출해도 된다. running 상태의 `start()`는 idempotent하다. 한 instance는 한 소비자·한 번의 lifetime을 지원하며 종료·실패 후 재시작하려면 새 instance를 만든다. 동시에 두 pending `next()`를 요청하면 `OBSERVER_CONCURRENT_NEXT`다. `stop()`, 외부 AbortSignal, `iterator.return()`, `for await`의 `break`가 진행 중 capture/Git과 대기 timer를 취소하고 worker 정리를 기다린다. Abort로 끝나는 `next()`도 정리가 완료된 뒤 `done:true`다. 오류는 다음 `next()`에서 한 번 throw하고 이후 `done:true`로 끝나며 background worker에서 unhandled rejection을 만들지 않는다.

`WorkspaceObserverOptions`는 `{signal?, intervalMs?, gitTimeoutMs?, maxGitEntries?, capture?}`다. polling interval은 각 poll 완료 뒤의 지연이고 기본 1,000ms, 정수 50~60,000ms만 허용한다. poll은 overlap 없이 capture와 Git status를 순서대로 실행한다. `gitTimeoutMs` 기본 10,000ms는 각 Git subprocess에 적용한다. `maxGitEntries` 기본 2,000, 범위 1~20,000이다. `capture`는 기존 capture limit 옵션을 받아 동일한 hard ceiling으로 제한하되 files/bytes/entries는 양수, depth는 0 이상이어야 한다. OS의 recursive watcher 지원을 가정하지 않으며 filesystem write·명령 effect·DB journal을 수행하지 않는다.

`WorkspaceObservation`은 `{type:'initial'|'change', workspaceId, sequence, observedAt, files, changes, git, warnings, captureComplete, incomplete, coalesced}`다. `files`는 `ReadonlyMap<relativePath,{hash,bytes}>`이고 **file content를 전달하지 않는다**. `git`은 기존 GitStatus에 `totalEntries`·`entriesTruncated`를 추가한 구조다. `changes`는 `{path, kind, beforeHash, afterHash}` 목록이다. 완전한 직전 snapshot 뒤의 새 경로는 `added`, 알려진 hash 변경은 `modified`, 완전한 현재 capture에서 부재가 확인된 경로는 `removed`다. 불완전한 현재 capture에서 빠진 기존 경로는 `unobserved`이며, 불완전한 직전 snapshot 뒤에 새로 보이는 경로는 `observed`로 표시한다. 부재·새 파일을 근거 없이 확정하지 않는다.

처음 전달하는 sample은 소비자가 늦어도 `initial`이다. 이후 실제 file hash·Git branch/status·warnings 변경에만 전달한다. 내부 대기 sample은 최신 하나뿐이고 덮어쓴 변경 sample 수를 `coalesced`에 기록한다. delta는 마지막 **전달된** sample과 비교하므로 중간 sample을 버려도 현재 상태까지의 비교가 유지된다. 이전 전달 sample과 최신 대기 sample 각각은 capture/file·Git-entry 한도 안에 있다. 누락된 경로의 hash를 무한 병합·축적하지 않는다. 소비자에게 반환하는 Map·file object·Git entries·warnings는 별도 복사본이며 소비자 mutation이 내부 비교 baseline을 손상하지 않는다. poll별 `sequence`는 영속 journal seq가 아니고 unchanged poll·coalescing으로 gap이 생길 수 있다.

capture warning이 하나라도 있으면 `captureComplete=false`다. Git 반환 entries를 자르면 추가 warning과 `entriesTruncated=true`, `incomplete=true`를 기록한다. 반환 entries 밖의 Git 상태 변경도 full bounded Git-result fingerprint에 반영해 wake한다. warning 최대는 capture의 200개+Git truncation 1개다. 파일 capture와 Git status가 단일 시점이라고 주장하지 않으며 Run의 변경과 외부 변경을 귀속하지 않는다.

observer는 시작 시 root의 bigint `dev/ino`를 저장하고 sample 전후 canonical root와 identity를 재검증한다. 같은 경로의 다른 real directory로 교체된 경우와 escaping root symlink를 실패로 처리한다. 검증과 stat 사이에 root가 사라지는 race도 typed `WORKSPACE_UNAVAILABLE`로 정규화한다. root가 열린 시점부터 observer 시작 이전까지 교체된 경우의 원래 inode는 고정 Workspace 계약에 없어서 비교하지 못한다.

추가 실제 검증:

```sh
node node_modules/tsx/dist/cli.mjs --test packages/engine/src/workspace/index.test.ts packages/engine/src/workspace/observer.test.ts
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/workspace/index.ts packages/engine/src/workspace/git.ts packages/engine/src/workspace/observer.ts packages/engine/src/workspace/index.test.ts packages/engine/src/workspace/observer.test.ts
```

최종 **source tests 27 passed / 0 failed / 0 skipped**(기존 14+observer 13), 약 3.8초. strict noEmit 검사는 exit 0, diagnostics 없음. 임시 `/tmp/moodcode-workspace-compiled-*` 디렉터리에 workspace source/test만 같은 strict NodeNext 옵션·`--rootDir packages/engine/src/workspace --outDir <temporary>`로 emit하고 임시 ESM package·root node_modules symlink를 구성한 뒤 `node --test <temporary>/index.test.js <temporary>/observer.test.js`도 실행했다. **compiled tests 27 passed / 0 failed / 0 skipped**, 약 3.8초. 임시 build는 finally에서 제거했고 shared dist·전체 monorepo build는 건드리지 않았다.

observer 13개 테스트는 실제 임시 Git repo에서 initial/add/edit/delete/branch/index stage/commit 상태, unchanged poll 억제, 느린 소비자 latest-only·delivered-baseline delta·지연된 initial, 소비자 mutation isolation, oversized partial capture와 unobserved/observed 분류, file/Git entry limit·반환 범위 밖 Git 상태 변경, AbortSignal·pre-abort·idle stop·listener 제거, concurrent next, for-await break, in-flight fake Git PID 종료, real-directory root replacement·escaping symlink·Git 제거 오류 1회 전파, interval 최소값과 positive limit를 검증했다.

추가 한계 및 root 통합 제안:

- polling 사이에서 발생했다가 되돌아오는 변경은 놓칠 수 있고 slow consumer는 중간 event를 잃는다. 이 service는 durable event journal/replay가 아니다. `coalesced`와 전체 최신 snapshot을 사용해야 한다.
- binary/oversized/permission/limits 등의 capture warning은 보수적으로 전체 capture를 incomplete로 취급한다. unrelated warning이 있어도 absence를 `unobserved`로 표시할 수 있다. 이전 hash를 무한 보존하지 않으므로 다시 보인 경로의 `beforeHash=null`·`kind=observed`는 이전 부재의 증명이 아니다. 제외된 파일의 내용 변경이 Git status를 바꾸지 않으면 관찰되지 않을 수 있다.
- sample 전후 검사도 root/parent TOCTOU를 원자적으로 제거하지 못한다. cancellation은 이미 진행 중인 일반 filesystem await가 반환되는 것을 기다린다. filesystem이 무한정 응답하지 않는 환경을 강제로 중단하는 별도 worker/process 분리는 구현하지 않았다. Git subprocess에는 기존 timeout과 abort가 적용된다.
- Electron/GUI 연결과 Windows runtime 검증은 실행하지 않았다. root가 engine public exports에 `WorkspaceObserver`, `DEFAULT_WORKSPACE_OBSERVER_OPTIONS`와 관련 observation/options 타입을 re-export하면 Electron utility process에서 직접 사용할 수 있다. 공통 facade/contract 변경은 이 service에 필요하지 않다. Electron owner는 lifetime 종료 시 `stop()`을 await하고 IPC에서 Map을 배열로 명시적으로 serialize하는 것이 적절하다.

## 추가 단계 — 첫 GUI용 읽기 전용 presentation

2026-10-04. `packages/engine/src/workspace/presentation.ts`와 `presentation.test.ts`를 구현했다. 이 단계에서는 workspace `index.ts`를 포함해 root facade·validation·공통 exports·contracts·ports를 수정하지 않았다. root는 `./workspace/presentation.js`에서 아래 함수를 import해 연결하면 된다.

정확한 API와 JSON 반환 shape:

```ts
getWorkspaceStatus(workspace: Workspace, signal?: AbortSignal): Promise<{
  workspaceId: string;
  branch: string | null;
  clean: boolean;
  dirty: boolean;
  changedFiles: { path: string; index: string; worktree: string; originalPath?: string }[];
  totalChangedFiles: number;
  truncated: boolean;
  warnings: string[];
}>

listWorkspaceFiles(workspace: Workspace, path = '', options?: {signal?: AbortSignal}): Promise<{
  path: string;
  entries: { path: string; name: string; kind: 'file' | 'directory'; bytes?: number }[];
  truncated: boolean;
  warnings: string[];
}>

readWorkspaceFile(workspace: Workspace, path: string, options?: {signal?: AbortSignal}): Promise<{
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  truncated: false;
}>
```

추가 export는 `WORKSPACE_PRESENTATION_LIMITS`, `WorkspacePresentationOptions`, `WorkspaceStatusPresentation`, `WorkspaceFileEntry`, `WorkspaceFilesPresentation`, `WorkspaceFilePresentation`다. 기본 객체/배열만 반환하며 Map·bigint·absolute host path를 JSON payload에 넣지 않는다. 파일 읽기의 `bytes`는 원본 파일 byte 수이며 `sha256`은 원본 byte hash다. directory entry에는 `bytes`가 없다. `path`는 `./`·중복 separator를 정리한 workspace-relative 문자열이고 root listing은 `''`이다.

status는 저장된 `workspace.branch`를 복사하지 않고 실제 `getGitStatus`를 호출한다. branch/index/worktree·rename·untracked filename을 보존하고 `totalChangedFiles`·`dirty/clean`은 반환 항목 제한과 독립적으로 실제 Git 결과를 유지한다. 최대 1,000 changed entries, 전체 status JSON 256KiB로 제한하고 생략 시 `truncated`·warning을 반환한다. root anchor의 canonical path·bigint dev/ino를 요청 전후 재검증한다.

listing은 한 directory만 `opendir`로 관찰하고 최대 1,000 **inspected entries**에서 중단한다. 제외되거나 symlink/FIFO인 항목도 탐색 한도를 소비한다. 결과는 directory 우선·이름 순으로 정렬한다. `.git`, `node_modules`, `.hg`, `.svn`, `build`, `dist`, `coverage`, `out`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.cache`, `.turbo`, `.vite`, `.parcel-cache`, `.angular` component를 case-insensitive하게 제외한다. 직접 요청한 제외 경로도 `PATH_EXCLUDED`로 거절하며 canonical relative path에도 같은 규칙을 적용한다. symlink·nonregular·읽을 수 없는 child는 생략하고 `truncated=true`·bounded warnings로 표시한다. 표준 excluded component 생략만으로 truncated를 표시하지 않는다. 결과 JSON은 256KiB, warnings는 20개로 제한한다. JSON prefix fitting은 binary search로 수행해 긴 경로에서 quadratic 반복을 피한다. metadata 자체가 JSON 한도를 넘으면 `PRESENTATION_TOO_LARGE`다.

read는 모든 lexical symlink component(내부/외부/부재 target 포함)를 거절한다. `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, regular-file 판정과 bigint identity를 사용하며 원래 크기+1 byte 이하, 최대 512KiB+1만 descriptor에서 읽는다. 읽기 전 candidate/descriptor·읽기 후 descriptor/current path의 dev/ino·size·nanosecond mtime/ctime을 비교하고 canonical 경로·root anchor도 다시 확인한다. 512KiB는 허용하고 1 byte 초과는 거절하며 content를 자른 성공을 만들지 않는다. UTF-8 BOM·CRLF·multibyte·empty 파일을 보존한다.

주요 오류 코드는 `ABORTED`, `FILE_TOO_LARGE`, `BINARY_FILE`, `INVALID_UTF8`, `FILE_CHANGED`, `SYMLINK_NOT_ALLOWED`, `NOT_REGULAR_FILE`, `NOT_DIRECTORY`, `PATH_EXCLUDED`, `INVALID_WORKSPACE_PATH`, `PATH_OUTSIDE_WORKSPACE`, `PATH_NOT_FOUND`, `PATH_NOT_DIRECTORY`, `PATH_UNAVAILABLE`, `DIRECTORY_CHANGED`, `FILE_UNREADABLE`, `DIRECTORY_UNREADABLE`, `WORKSPACE_ROOT_CHANGED`, `WORKSPACE_UNAVAILABLE`, `PRESENTATION_TOO_LARGE`다. Git subprocess 오류는 기존 Git error code를 유지한다. raw OS error는 파일/디렉터리용 typed code로 정규화해 임의 host diagnostics를 노출하지 않는다.

검증 환경은 기존 macOS·Node v26.9.0·Git 2.55.0이다. 최종 명령:

```sh
node node_modules/tsx/dist/cli.mjs --test packages/engine/src/workspace/presentation.test.ts
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/workspace/presentation.ts packages/engine/src/workspace/presentation.test.ts
```

**source tests 14 passed / 0 failed / 0 skipped**, 약 1초. **strict noEmit exit 0**, diagnostics 없음. 별도 `/tmp/moodcode-presentation-compiled-*`에서 strict NodeNext로 관련 source/test를 emit하고 ESM package·root node_modules symlink를 구성한 `node --test <temporary>/presentation.test.js`도 **14 passed / 0 failed / 0 skipped**, 약 0.9초였다. 임시 output은 finally에서 제거했고 shared dist·전체 monorepo build는 수정하지 않았다.

테스트는 실제 Git branch/index/untracked/rename/detached 상태, lazy tree·정렬·direct exclusion·lexical traversal/absolute/NUL/backslash/path-size 경계, 내부/외부/부재/parent symlink, FIFO 비차단, BOM/CRLF/multibyte/empty·원본 hash, 정확한 512KiB와 +1·binary·invalid UTF-8 코드, 1,100 files entry 제한, 800개 긴 경로 JSON 제한, 1,050 skipped symlinks의 탐색/warning 한도, pre-abort·진행 중 cancellation을 검증했다. 실제 FileHandle.read를 test-local hook으로 관찰하여 읽기 도중 파일 교체·512KiB 초과 growth·AbortSignal·real-directory root 교체를 결정적으로 유발했고 거절 코드와 실제 descriptor close를 확인했다.

한계: filesystem snapshot과 후속 효과는 원자적이지 않다. parent component TOCTOU는 O_NOFOLLOW와 전후 검사만으로 완전히 제거하지 못한다. request 시작 이전 root 교체의 원래 inode는 고정 Workspace 계약에 없어서 알 수 없다. listing은 변화/entry/JSON cap 이후 incomplete subset이고 현재 child byte size도 그 순간 관찰값이다. Git branch와 status 역시 단일 atomic 시점이 아니다. UTF-8 binary 판별은 기존 read tool의 control-byte heuristic을 사용하며 모든 binary format을 구별하지 않는다. Windows short-name canonical exclusion을 재검증하도록 구현했으나 Windows·Node 24·Electron/GUI 연결은 실행 검증하지 않았다. 읽기 content 한도는 원본 byte 기준이며 JSON escaping으로 transport byte 수가 커질 수 있다. 서비스는 workspace를 쓰거나 Run/approval/DB 기록을 생성하지 않고 변경 원인을 귀속하지 않는다.
