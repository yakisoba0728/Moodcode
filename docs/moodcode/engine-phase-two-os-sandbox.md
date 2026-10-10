# MC2-17: 실제 OS sandbox — Darwin opt-in 검증

이 기능은 `osSandbox: true`인 Engine의 실제 효과 프로세스에 파일·네트워크 제한을 적용한다. 검증 환경은 Darwin 27.0.0 / arm64이며 `/usr/bin/sandbox-exec`로 실행한 프로세스와 그 자손의 실제 syscall 거부를 확인했다. 기본값은 비활성이다. 기존 일반 command backend의 `fileIsolation/networkIsolation=false` 선언은 유지한다.

Apple 배포 manpage(`/usr/share/man/man1/sandbox-exec.1`)는 이 CLI를 deprecated로 명시한다. Apple DTS도 사용자 지정 SBPL을 제삼자용 지원 API로 보지 않는다. 따라서 capability는 `supportTier: experimental-deprecated-cli`이며, 현재 커널·실행파일·실측 probe에 묶인 실험적 지원이다. Apple의 정식 App Sandbox 제품 지원을 주장하지 않는다. [Apple DTS 설명](https://developer.apple.com/forums/thread/661939), [Apple App Sandbox 문서](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox).

## 실제 지원 범위

| 효과 경로          | 이번 구현                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 명령         | 실제 approved `run_command`, 원래 Tool/Part·supervisor·PID/group·효과 lock·checkpoint·budget 유지                                                           |
| 독립 host command  | 원래 Original host preview/approval/lease와 compact native receipt에 exact sandbox launch 추가                                                              |
| child              | 실제 Root가 생성한 격리 checkout에 상대 경로 scope를 매핑하고 더 작은 config/budget에 결속; parent grant 변경 시 거부                                       |
| stdio MCP          | Root가 직접 생성한 실제 readonly server + 별도 IPC lifetime supervisor. write scope는 항상 비우며 파일·자손·네트워크 거부를 실제 모델 Tool/Part 경로로 검증 |
| 파일               | 선택한 workspace 내부 canonical 경로만 읽기/쓰기. 선택한 파일·디렉터리의 물리 identity와 파일 SHA를 매번 재검증. symlink 밖 접근은 커널에서 거부            |
| 네트워크           | 모든 network deny. 실제 loopback 서버의 연결 0건 확인. 선택적 network allow는 미지원                                                                        |
| Linux/Windows/기타 | 이 OS sandbox backend 미지원; capability false 및 typed rejection. 기존 unsandboxed 플랫폼 지원과 구분                                                      |

HTTP MCP, 임의 transport, 외부 callback/plugin/ACP, custom tools, repository/verification tools 및 host lifecycle callbacks는 이 모드에서 효과 전에 typed unsupported로 거부한다. 특정 모델 공급자 자체를 sandbox 안에 넣는 기능은 아니다. provider는 신뢰된 엔진의 통신 경로이고, 모델이 요청한 shell/stdio 효과가 제한 대상이다. remote backend/callback을 커널이 제한한다고 표시하지 않는다.

## API와 승인

`registerSandboxBackend()`는 실제 allowed read/write, denied outside read/write, 자손 및 loopback probes를 실행한다. 전부 충족해야 세 isolation flags가 true가 된다. `getSandboxCapability()`는 관찰한 backend/version/supportTier를 반환한다.

`previewSandboxGrant({workspaceId,sessionId,config,readPaths,writePaths,network:'deny'})`는 Original opaque handle을 만든다. `readSandboxGrant(handle)`은 DATA snapshot이다. `approveSandboxGrant({workspaceId,requestId,expectedRevision:0,preview,fingerprint,approved:true})`는 같은 실제 handle과 fingerprint 및 idle workspace lease를 요구한다. copied/proxy/accessor DTO, denied 승인, stale source/config/catalogue/profile 또는 busy physical owner는 실행 권한을 만들지 못한다. 승인 원문을 조회하거나 가져온 기록을 읽어도 runtime grant가 재발급되지 않는다.

Root 물리 binding/epoch, OS release, sandbox 실행파일과 현재 Node executable identity/SHA, 정확한 restriction/profile, normalized config 전체·profile/capability/catalogue/budget를 pin한다. 승인 후 파일/디렉터리 replacement와 확대된 allowlist는 fail closed 또는 새로운 idle Original 승인이다. 임의 host credential 환경은 effect에 전달하지 않는다. HOME/TMPDIR는 workspace이고 엔진 DB/owner/effect/review 파일과 WAL/SHM/journal 및 artifacts는 workspace 안에 있어도 deny한다. workspace 루트의 `.git` 항목과 `.git/config`·`config.worktree`·`commondir`·`hooks`·`info`·`modules`·`worktrees`·`rebase-merge`는 읽기를 유지한 채 effect의 쓰기만 거부한다. sandbox 밖 Git이 이 경로의 hook·설정 명령이나 rebase todo의 `exec` 줄을 실행하거나 다른 gitdir로 전환하기 때문이다. preview와 child 상속 때 hook·filter·fsmonitor를 실행하지 않는 읽기 전용 Git으로 실제 `core.hooksPath` 디렉터리와 모든 config include/includeIf 대상(조건이 맞지 않는 include 파일 안의 중첩 include 포함)을 해석한다. write grant 안에 있으면 그 경로와 거기까지 거치는 디렉터리·symlink 항목의 쓰기도 거부하고, workspace 저장소를 이렇게 읽지 못하면 grant를 만들지 않는다. 그래서 sandbox 안의 `git rebase`(기본 merge backend, `-i` 포함)와 `git worktree add`는 실패한다. 남은 위험: workspace 안에 새로 만든 중첩 저장소, 승인 후 사용자가 바꾼 hooksPath·include(다음 preview부터 반영), hook이 실행하는 추적 파일(예: husky의 `.husky/*`)은 보호하지 않는다. trusted supervisor의 DB/artifact I/O는 제한된 effect 자손에 전달하지 않는다.

`connectSandboxedMcp()`만 OS 모드에 들어올 stdio transport를 만들 수 있다. 연결 후 catalogue 변경으로 새 exact grant가 필요하다. `bindSandboxedMcp(client ORIGINAL)`가 최초 한 번 실제 process/PID/source와 새 승인 catalogue만 독립 native binding으로 연결하며 경로·config·권한 확대는 허용하지 않는다. bind 전에는 initialize/list bootstrap만 가능하고 model RPC는 0회다. bind 이후 같은 정책의 재승인도 이전 채널을 stale로 만들며 새 physical connection이 필요하다. sourceFiles SHA가 바뀌면 다음 send 전에 거부한다. 실제 approval Tool/Part 경로를 통해서도 같은 제한이 유지된다. 기존 `connectMcp()`의 임의 stdio/HTTP 인스턴스는 startup 전에 거부한다.

## 저장·실패·복구

DB23에 새 migration/table을 추가하지 않는다. `sandbox.record.<id hash>` SessionDocument CAS와 별도 `sandbox.record` native immutable event의 full signed snapshot을 같은 primary transaction에 저장한다. command source는 실제 Run/Turn/Attempt/Tool/allowed approval에 결속한다. 실제 started PID, 물리 outcome, sealed stdout/stderr, checkpoint 전체 SHA 및 partial file 목록을 저장하고 native checkpoint/header와 실제 owned-command closed event가 있으면 그 독립 증거까지 검증한다. 기록 256개, 이벤트 8192개, row 128KiB, 총 16MiB 및 metadata-first body bound를 둔다.

`closed`는 물리 프로세스가 정리된 영수증이다. provider Run 성공을 의미하지 않는다. exit, cancellation, timeout, cleanup uncertainty와 checkpoint 부분 효과는 그대로 남긴다. stderr의 EPERM 텍스트는 untrusted process output이다. 특정 명령의 kernel denial 원인을 stderr만으로 확정하지 않아 `denialObserved:false`와 unknown classification을 저장한다. syscall 거부의 지원 증거는 독립 실제 probes/tests이고, 명령 실패 원인은 원래 output/exit로 조회한다. denied 이후 부분 쓰기를 자동 롤백·재실행하거나 scope를 확대하지 않는다.

시작 receipt SQL fault는 spawn 0이다. 실행 후 closed receipt fault는 실제 부분 효과를 보존하고 Run cleanup uncertainty와 미완결 native 상태를 남긴다. 실제 Root SIGKILL 시 기존 명령 supervisor와 새 stdio MCP lifetime supervisor가 각 effect/자손을 정리한다. reopen은 interrupted starting/running을 `uncertain`으로 append하고 grant를 복원하거나 provider/command/MCP를 replay하지 않는다. archive/import는 원래 영수증과 chain을 보존한 `paused-import` head를 만든다. 조회는 DATA뿐이다.

## 검증 및 남은 지원

실제 temp Git workspace, 실제 Engine/approval/native SQL, 실제 커널 실행과 실제 loopback HTTP 서버만 사용했다. 계정·토큰·실모델·외부 쓰기·배포는 사용하지 않았다. 기능별 source tests는 파일/네트워크/자손/child/MCP/timeout/cancel/close/SQLfault/native drift/SIGKILL/reopen/import와 duplicate grant history를 포함한다. 인접 명령·supervisor·MCP·host/job·child approval 회귀도 별도로 실행했다. 구체 명령, counts와 SHA는 동반 verification JSON에 기록한다.

이 실제 Darwin lane이 MC2-17a–d의 이번 종료 범위다. 정식 Apple entitlement/container backend, 다른 OS, selected network allowance, remote effects, sandbox-bound verification/repository/lifecycle callbacks 및 per-command privileged kernel denial audit는 남은 확장이다. E5-13/E5-08/E6-07/E6-08은 이번 증거로 닫지 않는다. 전체 통합 gate와 progress 변경은 Root가 담당한다.
