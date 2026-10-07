# RepositoryContextService bounded snapshot 측정

실제 compiled Engine의 `getRepositoryContext()`를 현재 Moodcode 저장소에 연결해 측정했다. 이 lane은 host LSP를 등록하지 않은 상태의 explicit path 읽기·파일 hash·Git/ignore metadata·source manifest 생성 비용을 확인한다. semantic symbol/definition/reference 품질, 전체 저장소 LSP index 성능, cache 개선을 측정한 결과가 아니다.

원본 evidence는 [engine-repository-benchmark.json](engine-repository-benchmark.json), 재현 script는 [benchmark-repository-context.mjs](../../scripts/benchmark-repository-context.mjs)다.

## 재현

저장소 root에서 기존 compiled engine이 있는 상태로 실행한다. runtime은 script가 속한 Moodcode의 `packages/engine/dist/engine.js`이며 `--root`는 읽을 저장소를 선택한다. Script는 engine을 자동 build하지 않는다.

```sh
npm run build
node scripts/benchmark-repository-context.mjs --root . --iterations 5 > docs/moodcode/engine-repository-benchmark.json
```

`--iterations`는 3/4/5만 받는다. `--root`를 생략하면 script가 속한 프로젝트 root를 사용한다. Code inventory는 Git tracked/untracked 목록 중 `apps`, `packages`, `scripts`의 명시된 코드 확장자만 선택하며 `node_modules`, `dist`, `build`, `.git`, cache/coverage/output 디렉터리를 제외한다. 최대20,000 files·전체256MiB·개별32MiB를 검사하고 alias/symlink source를 거절한다. 임의 디렉터리를 recursive traversal하지 않는다.

Engine SQLite/artifacts는 OS temporary directory에 생성하고 마지막에 close/remove한다. Source file을 쓰거나 모델 Run을 제출하지 않는다. CLI의 JSON 출력 경로만 호출자가 선택한다. 작업 중 corpus가 변경될 수 있으므로 inventory는 한 번 순회한 관측이며 atomic whole-tree snapshot으로 표시하지 않는다.

## 관측 환경과 source

Evidence 기록 시각은 **2026-10-07 13:15:57 UTC**, Node **v26.9.0**, macOS arm64다. 실제 OS release, cwd/root/runtime root, 실행 인자, compiled implementation file hashes는 JSON에 기록했다.

- Git HEAD: `28408cb821eb2427210d18495ea1ea1a8aebb3db`. Code worktree는 dirty 상태이므로 이 commit만으로 모든 관측 source를 식별하지 않는다.
- Code inventory: **470 files / 6,426,973 bytes**. Production source, tests, fixtures, script를 포함한다. Inventory 읽기77.779ms는 query latency에 포함하지 않았다.
- 전체 inventory manifest SHA-256: `55636f37ccd1671ebf902a68c88a30d30fee09fe0961d27ffe088639a2649a00`.
- 고정한 source8개: config/index·config/budgets·context/index·context/plan·workspace/index·workspace/ignore·file-actions/text·provider/helpers. 합계 **85,243 bytes**이며 각 파일 path/bytes/hash가 JSON에 있다.
- 선택 source manifest SHA-256: `8f500197039b7c3d2998bc258c1bdd02a1c9bc6a573dbdb3b44226a6bba4b057`.

Query 전후 선택 source hashes, 기록한 compiled implementation hashes, Git HEAD가 동일했다. 네 query 각각의 generation도5회 모두 동일했다. 이 검사는 선택 source에 대한 것이며 전체 inventory의 동시 수정까지 atomic하게 검증한 것은 아니다.

## Query 결과

각 query를 같은 actual Engine instance에서 순차5회 실행했다. Timer는 `engine.getRepositoryContext()` 호출 직전부터 Promise resolve까지이며 별도 corpus inventory·Engine 생성·SQLite evidence 읽기는 포함하지 않는다. 반복을 cold/warm cache로 분류하지 않는다.

| Query | Source paths | Median ms | Min–max ms | Result bytes | 선택 source bytes | Unsupported paths |
|---|---:|---:|---:|---:|---:|---:|
| symbols | 8 | 22.074 | 21.075–23.486 | 2,329 | 85,243 | 8 |
| symbols | 1 | 18.199 | 17.861–18.535 | 875 | 14,916 | 1 |
| definition | 1 | 18.056 | 18.002–18.534 | 914 | 14,916 | 1 |
| references | 1 | 17.909 | 17.719–19.237 | 914 | 14,916 | 1 |

여기서 선택 source bytes는 결과 manifest에 hash가 들어간 원본 파일 byte 합계다. 결과에 원본 source text를 포함한 양은0이다. LSP relation source도0이며 definition/references의 위치는 line0/character0이다.

**20개 sample 모두 `complete=false`, semantic observations0**이다. Host language routing이 없으므로 TypeScript file은 모두 unsupported path로 정직하게 반환했다. `omittedObservations=0`은 semantic 결과가 있다는 뜻이 아니다. 모든 sample이 paths8·result16,384 bytes·source4,194,304 bytes의 cap 안에 있었고 authority는 `read-only`였다. 평균과 개별시간·generation·manifest hash는 JSON에서 확인할 수 있다.

Default core catalogue는 **21 tools**로 유지됐으며 repository context tool opt-in은 사용하지 않았다. Provider invocation, Run, tool result, checkpoint, approval, provider Attempt는 모두0이었다. PTY·command backend·language server를 호출하지 않았다. 실제 Repository/Workspace API가 사용하는 read-only Git metadata commands는 실행됐으며 그 process 수는 측정하지 않았다. Temporary engine files는 제거됐다.

## 남은 lane

이 결과는 실제 코드 corpus를 대상으로 하는 bounded read snapshot의 재현 가능한 관측이다. MC2-01d 전체 완료 증거로 쓰지 않는다. 실제 host LSP를 연결한 큰 corpus에서 symbol/definition/reference의 정확성, unsupported/omission 의미, source generation invalidation, result truncation·memory/time caps를 별도로 검증해야 한다. 비교 baseline 없이 성능 향상이나 cache 최적화 효과를 주장하지 않는다.
