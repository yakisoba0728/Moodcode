# 06 — 읽기·검색 도구 구현 보고서

작성일: 2026-10-04, Asia/Seoul. 담당 구현과 검증을 완료했다. 고정 contracts/ports와 다른 담당 모듈, package 설정은 수정하지 않았다.

## 구현 파일과 export

- `packages/engine/src/tools/read/index.ts`: `createReadTools(): ToolDefinition[]`, `READ_TOOL_LIMITS`.
- `packages/engine/src/tools/read/read.test.ts`: 임시 Git workspace fixture 기반 읽기 도구 테스트.

`createReadTools`는 `list_files`, `read_file`, `search_files`를 반환한다. 모든 도구는 `requiresApproval=false`이며 `prepare`는 filesystem 접근 없이 입력 검증·정규화·preview·SHA-256 fingerprint만 만든다. 실행 시 이름·입력·workspace ID/root·fingerprint를 확인한다. 경로 접근은 고정 `resolveWorkspacePath` export를 사용한다. contracts/ports 변경 제안은 없다.

## 결과와 동작

각 결과는 모델용 `content`와 구조화된 `data`를 제공한다. `content`는 정상 한도에서 `data`의 JSON이다. `maxOutputBytes`에는 JSON escaping·메타데이터까지 포함한 최종 UTF-8 byte 길이를 적용한다. 파일 본문이나 목록/검색 결과의 가장 긴 prefix를 byte 한도 내에서 유지하며 실제 반환량 메타데이터도 함께 갱신한다. 메타데이터 자체보다 작은 출력 한도에서는 짧은 생략 안내를 반환하고 정확한 정보는 `data`에 남긴다. UTF-8 다중 byte 문자와 surrogate pair를 중간에서 자르지 않는다.

- `list_files({path?, limit?})`: `data.files: string[]`, `returnedCount`, scan 메타데이터를 반환한다. 디렉터리의 regular file만 목록에 넣고 binary 파일 이름도 포함한다. 기본 limit 200, 최대 2,000이다. 요청 path가 regular file이면 그 파일 하나를 반환한다.
- `read_file({path, startLine?, endLine?})`: `data.sha256`은 선택 줄/출력 한도 전 **전체 원본 byte**의 hash다. `bytes`, `encoding`, `content`, `totalLines`, `requestedStartLine`, `requestedEndLine`, 실제 `startLine`/`endLine`, `returnedBytes`, `returnedLines`, `partialLastLine`을 제공한다. 줄 번호는 1부터 시작하는 inclusive 범위이며 빈 파일은 0줄, terminal newline은 별도 빈 줄로 세지 않는다. EOF 밖 범위는 본문 빈 문자열과 실제 줄 범위 `null`을 반환한다. UTF-8 BOM·CRLF·terminal newline을 보존한다.
- `search_files({query, path?, limit?})`: case-sensitive literal substring의 겹치지 않는 각 발생 위치를 반환한다. `data.matches` 항목은 `{path, line, column, text, snippetStartColumn, snippetTruncated}`다. line/column은 1부터 시작하고 column은 UTF-16 code unit 기준이다. newline 포함 literal도 검색하며 위치는 match 시작점이다. 긴 줄의 snippet은 검색 위치에서 시작하여 실제 매치가 줄 prefix 밖에 있어도 보이게 한다. 기본 limit 100, 최대 1,000이다.

목록·검색은 모든 깊이의 `.git`, `node_modules`, `.hg`, `.svn`, `.next`, `dist`, `build`, `coverage` 디렉터리를 대소문자와 관계없이 제외한다. 명시 path와 canonical resolved path의 부모 디렉터리에도 같은 제외를 적용한다. 순회 중 내부/외부/loop symlink를 모두 건너뛴다. 명시적인 `read_file`은 adapter가 허용한 내부 symlink를 읽을 수 있고 제외 디렉터리 내 파일도 직접 읽을 수 있다. `.gitignore`는 사용하지 않는다.

`data.truncated`, `truncationReasons`, `outputTruncated`로 누락 원인을 표시한다. 목록/검색은 실제 추가 파일·매치를 관찰한 경우에만 각각 `files`/`results`로 표시하므로 limit과 정확히 같은 결과는 개수 제한 때문에 잘렸다고 표시하지 않는다. 사유는 `files`, `entries`, `results`, `bytes`, `lines`, `file_bytes`, `snippet_bytes`, `unreadable`, `output_bytes`다. binary와 제외 디렉터리/symlink는 검색 대상 정책에 따른 제외이며 누락 한도와 구분한다.

검색·목록 scan 메타데이터는 `entriesVisited`, `filesVisited`, `bytesScanned`, `skippedBinaryFiles`, `skippedLargeFiles`, `skippedSymlinks`, 최대 20개의 `warnings`와 `warningsOmitted`다. `bytesScanned`는 실제 읽은 byte를 세며 binary/관찰 중 변경 파일의 읽은 byte도 총 한도에 포함한다. unreadable 항목은 제한된 경고와 `unreadable` 사유로 불완전한 결과를 표시한다.

## 한도·취소·파일 안정성

고정 hard limits는 파일당 2MiB, read 반환 최대 2,000줄, 탐색 최대 2,000파일/20,000entries, 검색 읽기 전체 16MiB, 파일당 검색 20,000줄, 검색 결과 1,000개, snippet/query 각각 2,048 UTF-8 bytes다. path 입력은 최대 4,096 UTF-8 bytes다. limit/줄 번호는 양의 safe integer만 허용하며 역순 범위·알 수 없는 입력 property·빈 query·traversal/절대경로/NUL/backslash를 거절한다.

외부 `rg`, shell, provider API, artifact 쓰기, checkpoint 효과가 없다. `opendir` streaming iteration과 iterative traversal을 사용하고 파일은 최대 64KiB 청크로 읽는다. 파일당 크기와 남은 검색 byte budget을 읽기 전 확인하여 allocation/read를 제한한다. binary 판정은 NUL/일부 제어 byte 또는 invalid UTF-8을 기준으로 한다. binary `read_file`은 `BINARY_FILE`, oversized 파일은 `FILE_TOO_LARGE`로 실패하고 prefix hash를 전체 hash로 표시하지 않는다.

읽기 전후 descriptor size·nanosecond mtime/ctime와 최종 pathname의 inode/device·size·mtime/ctime를 비교하고 상대 경로도 다시 resolve한다. 관찰 중 변경은 `FILE_CHANGED`로 실패한다. `AbortSignal`은 prepare/execute, 디렉터리 항목, 파일 읽기 청크, 검색 loop, 결과 직전에 확인하며 `CANCELLED`로 실패한다. filesystem 오류와 취소가 겹쳐도 취소를 우선한다. 파일·디렉터리 handle은 취소/오류에서도 닫는다.

## 실제 검증

실행 환경은 macOS, Node `v26.9.0`, Git `2.55.0`이며 통합 세션이 설치한 tsx/TypeScript를 사용했다. fixture Git 초기화는 임시 디렉터리에서만 수행하고 shared checkout의 Git 상태는 조작하지 않았다. 의존성 설치·전체 monorepo build는 수행하지 않았다.

```sh
npx --no-install tsx --test packages/engine/src/tools/read/read.test.ts
```

최종 결과: **27 passed / 0 failed / 0 skipped**, 약 2.90초. readonly catalog·filesystem 없는 prepare, 입력형태/safe integer/query byte 검증, 제외 디렉터리·대소문자·명시/canonical symlink 경로, loop/external symlink, trailing slash 경로 정규화, 목록/검색 limit 정확경계, inclusive 줄 범위·빈 파일·EOF·CRLF·BOM, 64KiB 청크 경계를 가르는 emoji, 전체 raw SHA-256, read/search 줄 한도 정확경계, binary/invalid UTF-8·파일당 2MiB 정확경계/초과, UTF-8 snippet과 먼 검색 위치, multiline literal·UTF-16 column, 2,000파일 탐색 한도, 16MiB 검색 총 byte 한도, JSON escaping을 포함한 1/16/128/512 byte 출력 한도, prepared 입력/workspace 변경, pre-abort/execute 시작 후 abort를 검증했다. 실제로 19,999개 dangling symlink와 제외 Git 디렉터리를 만든 뒤 20,000개 entry 정확경계와 추가 entry 1개에서 목록·검색의 truncation을 확인했다.

```sh
npx --no-install tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/tools/read/index.ts packages/engine/src/tools/read/read.test.ts
```

최종 결과: **exit 0**, diagnostics 없음. 담당 source/test만 strict 타입 검사했다. 독립 하위 검토에서 발견한 trailing slash 반환 경로의 중복 `/`를 수정하고 회귀 테스트를 포함했다. 초기에 fixture가 Git workspace를 초기화하지 않아 발생한 `NOT_GIT_WORKSPACE` 실패는 임시 fixture 초기화로 수정했으며 최종 검증에는 남은 실패가 없다.

## 한계와 통합 시 주의

- 탐색은 bounded filesystem observation이다. 경로 재검증·descriptor 검사는 변경을 감지하지만 외부 프로세스의 parent directory 교체를 원자적으로 잠그거나 전체 workspace snapshot을 만들지는 않는다.
- 동시 외부 writer에 의한 descriptor/path 변경 검사는 구현했지만 파일 내용을 읽는 정확한 순간에 mutation을 강제하는 race fixture는 실행하지 않았다. 권한 오류·특수 filesystem·모든 handle close 경합의 exhaustive 검증도 이번 단위 테스트 범위 밖이다.
- 파일당 2MiB를 넘는 `read_file`은 전체 hash를 얻기 위해 무한 스트리밍하지 않고 명확히 거절한다. 검색은 oversized 파일을 건너뛰며 `file_bytes` 사유로 불완전성을 표시한다.
- 파일 순회 순서는 OS enumeration에 따른다. 반환된 목록 자체는 정렬하지만 한도에서 선택된 부분 집합이나 검색 결과 순서가 전체 경로 정렬 순서라고 보장하지 않는다.
- binary 판정은 heuristic이며 valid UTF-8/control-free binary를 완벽하게 구분하지 않는다. invalid UTF-8 text도 읽지 않는다. symlink는 명시 읽기와 순회 정책이 다르다.
- API 입력 한도는 고정하고 결과 한도는 Run의 `maxOutputBytes`도 적용한다. 메타데이터보다 작은 한도에서는 모델용 문자열이 JSON이 아닐 수 있으며 `data`가 구조화 결과다.
- Windows·Node 24·Electron utility·전체 engine loop 통합은 이 담당 세션에서 실행 검증하지 않았다. 실제 provider API키 탐색·외부 비용 호출은 하지 않았다.

## 추가 단계 — 환경 진단 service와 doctor

2026-10-04 추가 병렬 구현 요청에 따라 `packages/engine/src/diagnostics/**`와 `scripts/doctor.mjs`를 구현했다. 공통 contracts/ports·package 설정·engine facade는 수정하지 않았다. 통합 세션이 `getDiagnostics`, `DIAGNOSTICS_LIMITS`, `DiagnosticsOptions`, `DiagnosticsReport`를 public engine index에 연결하고 `npm run doctor` script를 추가했다.

추가 파일은 `diagnostics/index.ts`(service/입력·report 한도), `types.ts`(JSON 계약), `checks.ts`(Node/command 정책·메모리 SQLite·artifact 권한), `git.ts`(bounded shell-free Git와 workspace 관찰), `diagnostics.test.ts`(33개 service 테스트), `doctor.test.ts`(10개 compiled CLI 테스트), `scripts/doctor.mjs`다.

```ts
getDiagnostics(options?: DiagnosticsOptions): Promise<DiagnosticsReport>

interface DiagnosticsOptions {
  workspacePath?: string;
  artifactParent?: string;
  credentialEnvNames?: readonly string[];
  gitExecutable?: string;
  timeoutMs?: number;
  maxReportBytes?: number;
  signal?: AbortSignal;
}
```

기본 report는 실제 `process.version`, platform/architecture, `process.versions.electron` 존재·버전, Node `>=24.0.0` 비교, command 플랫폼 정책, actual `node:sqlite` 가용성/메모리 query/SQLite version, Git 가용성/버전을 기록한다. Node version 인식 실패는 `meetsMinimum=null`이고 Git/SQLite version format을 인식 못해도 실제 probe 성공과 버전 미확인을 구분한다. `ok`는 이 기본 probe와 선택한 workspace/artifact 관찰이 확인되었음을 뜻하며 전체 엔진·공급자·배포 호환성 인증이 아니다.

SQLite는 dynamic import 후 `DatabaseSync(':memory:')`에서 고정 SELECT만 실행하고 항상 close한다. `SqliteStore`, 기존 DB 파일, owner lock, migration, backup을 열지 않는다. module/API 부재, query 결과 불일치, constructor/query 예외, close 오류, unknown version을 code로 구분한다. raw exception·stack·Git stdout/stderr를 report에 복사하지 않는다.

`credentialEnvNames`는 유효한 ASCII 환경변수 이름 최대 32개(각 128bytes)이며 중복을 제거한다. `{name, configured}`는 `Object.hasOwn(process.env,name)` 결과뿐이다. 빈 값도 존재하면 true이며 자격증명 유효성·공급자 인증·비용 호출 성공을 뜻하지 않는다. 값은 읽어 반환하지 않고 전체 env를 출력하지 않는다. Git child에는 PATH 등 최소 실행 환경만 전달하며 credentials, Node launch hooks, 상속 Git selectors/config injection을 제외한다.

선택 workspace는 canonical Git root, branch(unborn 포함/ detached는 null), porcelain v1 NUL status의 dirty·entry/untracked/conflict 수를 반환한다. 파일명/본문은 출력하지 않는다. malformed config·permission·non-repository가 모두 가능한 discovery 실패를 `GIT_WORKSPACE_DISCOVERY_FAILED`로 기록하고 단순히 “Git 저장소가 아님”으로 단정하지 않는다. system/global Git config는 무시하고 fsmonitor/untracked cache/optional index writeback을 끈다. report의 Git policy에 이 isolation과 POSIX group/direct-child cleanup 범위를 기록한다.

읽기 전용 진단을 유지하기 위해 branch와 함께 config key·index object mode를 먼저 조사한다. clean/process filter 설정, submodule, partial/promisor clone, 미확인 Git 버전, 실패/초과한 preflight는 status를 실행하지 않고 `status='not_checked'`, `dirty=null`, root/branch와 이유 code를 남긴다. `GIT_NO_LAZY_FETCH=1`도 설정하여 자동 object fetch를 비활성화한다. helper 설정 값과 remote URL은 반환하지 않는다. Git의 `--no-optional-locks`만으로는 내용 비교 중 clean/process filter 실행까지 막지 못한다는 점을 [Git status 소스](https://github.com/git/git/blob/v2.55.0/builtin/commit.c#L1523), [filter 변환 소스](https://github.com/git/git/blob/v2.55.0/convert.c#L1349)에서 확인하여 이 사전 검사를 추가했다. 자동 fetch 설정의 근거는 [Git 환경변수 문서](https://git-scm.com/docs/git#Documentation/git.txt-codeGITNOLAZYFETCHcode)다.

선택 `artifactParent`는 nearest existing ancestor의 canonical 경로, missing directory 수, 실제 permission mode(4자리 octal), R/W/X access 결과를 확인한다. parent나 probe 파일을 만들지 않는다. `createPossible`은 `assessment='access_checks_only'`인 추정이며 disk/quota/ACL/동시 변경을 검증하는 실제 쓰기 성공이 아니다. file/dangling ancestor는 positive 생성 추정으로 표시하지 않는다. Windows는 command 도구만 `COMMAND_PLATFORM_UNSUPPORTED`로 표시하고 Git/SQLite는 별도 probe를 수행한다. Windows artifact 생성 가능성은 `null`로 남긴다.

Git timeout은 프로세스별 기본 3,000ms, 최대 10,000ms다. stdout+stderr 합산으로 version 1KiB, root/config 8KiB, branch 1KiB, index/status 64KiB를 제한한다. 취소 시 POSIX original process group을 종료하고 streams/listeners/timer를 정리한다. 병렬 probe는 `allSettled`로 양쪽 정리를 확인한 뒤 `ABORTED`를 반환한다. report는 compact JSON UTF-8 기준 기본 16KiB, 허용 2KiB~64KiB다. JSON escaping까지 계산하고 경로·branch·warnings·credential 항목을 생략할 때 `truncated`, `omittedDetails`, omitted count를 남긴다. 부분 문자열 JSON을 반환하지 않는다.

doctor flags는 `--workspace`, `--artifact-parent`, 반복 가능한 `--credential-env`, `--git`, `--timeout-ms`, `--max-report-bytes`, `--json`, `--help`로 고정했다. unknown/duplicate/missing/invalid flag를 거절하고, human 문자열은 JSON escaping으로 terminal control 문자를 보존한다. JSON 출력은 LF까지 report 한도 내에 있으며 human 출력도 bounded다. exit 0=확인된 probe 성공, 1=실패/미확인 finding, 2=config/build 오류, 130=SIGINT, 143=SIGTERM이다. compiled diagnostics entry를 직접 import하므로 SQLite 부재도 facade import 실패 대신 JSON으로 회수한다.

### 추가 단계 실제 검증

```sh
npx --no-install tsc --ignoreConfig --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node --rootDir packages/engine/src/diagnostics --outDir packages/engine/dist/diagnostics --declaration --sourceMap packages/engine/src/diagnostics/*.ts
node --check scripts/doctor.mjs
node --test packages/engine/dist/diagnostics/diagnostics.test.js packages/engine/dist/diagnostics/doctor.test.js
npx --no-install tsx --test packages/engine/src/diagnostics/diagnostics.test.ts packages/engine/src/diagnostics/doctor.test.ts
```

최종 결과: 담당 compile/strict/syntax 검사 모두 **exit 0**. compiled **43 passed / 0 failed / 0 skipped**(약 5.76초), source **43 passed / 0 failed / 0 skipped**(약 5.84초). 실제 SQLite module 부재는 CLI를 `--no-experimental-sqlite`로 실행하여 확인했다. 실제 Git temp 저장소·unborn/detached·newline/rename/conflict·malformed config·filter/submodule/partial clone guard, index bytes/mtime 불변, DB/owner sentinel 불변, artifact 무생성, stdout+stderr 한도, missing Git, actual PID timeout/abort/descendant group 정리, 병렬 sibling cleanup, credentials/Node hook/Git selector 비전달, unknown versions, escaped JSON 한도·omitted 수, 최소 CLI byte 한도, build 부재, SIGINT/SIGTERM 종료 코드와 Git PID 제거를 검증했다. 모든 credential fixture는 `MOODCODE_*` 임시 이름을 사용하고 실제 공급자 키를 조회하지 않는다. fixture namespace 정리 후 해당 환경 isolation 테스트의 source/compiled targeted 재검증도 각각 1 passed였다. 모든 fixture 쓰기·Git init/add/commit/checkout은 OS temp 안에서만 수행했다. filter helper 실행 실험은 하지 않았다.

```sh
node scripts/doctor.mjs --workspace . --artifact-parent packages/engine/dist --credential-env MOODCODE_DOCTOR_PROBE_KEY --json
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/doctor.mjs --json
```

두 실제 doctor 실행 모두 **exit 0**. Node 실행은 `v26.9.0`, SQLite `3.53.4`, Git `2.55.0`, canonical Moodcode root/branch main/dirty state, artifact mode `0755`와 access 결과를 확인했다. Electron의 창 없는 Node 실행 모드는 Electron `44.5.1`, 실제 Node `v24.21.0`, SQLite `3.53.4`를 식별하고 `electron.detected=true`를 반환했다. Electron utility/full GUI bundle 검증과는 구분한다. 전체 monorepo build/test는 통합 세션의 범위로 남겼다.

### 추가 단계 한계

- Git status는 system/global config를 제외한 관찰이다. 사용자 global attributes/filter 설정이 적용된 평소 Git 결과와 차이가 있을 수 있다. 명시적인 filter/submodule/partial clone/unknown/preflight 실패는 상태를 추측하지 않고 미검증으로 남긴다.
- preflight와 status 사이의 외부 config/index 교체를 원자적으로 잠그지 않는다. directory permission/access와 이후 생성 가능성도 atomic 보장이 아니다. Windows의 actual runtime·ACL·Git child 종료는 실행 검증하지 않았고 platform 정책만 단위 검증했다. POSIX group 밖으로 이탈한 임의 descendant의 전체 종료를 약속하지 않는다.
- AbortSignal은 filesystem metadata 작업 전후에 확인하지만 이미 진행 중인 kernel filesystem I/O를 강제 취소하지 못한다. Git subprocess만 명시 timeout을 갖는다.
- 격리된 메모리 SQLite와 local Git만 검사한다. 기존 DB 무결성/owner 상태, 실제 자격증명 사용 가능성, provider/network/요금, 최종 GUI 배포 상태를 이 report의 성공으로 인증하지 않는다. 실제 API키 탐색·외부 공급자/비용 호출은 하지 않았다.
