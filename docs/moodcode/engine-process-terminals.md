# Moodcode command·PTY 실행 경계

이 구현은 Moodcode의 독립 엔진 모듈이며 OpenCode 구현을 복사하지 않았다. PTY의 OS 연결은 별도 선택 dependency인 Microsoft `node-pty@1.1.0`를 사용한다. 공개 API는 설치된 패키지의 typings 및 [공식 TypeScript 계약](https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts)을 확인했다. 원본 저장소 분석과 구현 dependency의 라이선스는 별개다.

## 실행 권한과 backend

| 범위 | 현재 동작 | 보장 경계 |
|---|---|---|
| 모델 `run_command` | 기존 승인·workspace lease·command supervisor·checkpoint 경로 유지 | 사용자 OS 계정으로 실행; 파일·네트워크 격리 없음 |
| 사용자 PTY | `TerminalService`의 host API만 사용 | `authority:user` + session/workspace 소유 확인; 모델 도구 catalog에 미등록 |
| POSIX command port | `PosixCommandBackend`가 기존 `executeShell`을 연결 | 원래 process group 소멸 확인; 단독 port는 engine crash supervisor를 제공하지 않음 |
| POSIX PTY | `PosixPtyBackend`가 별도 Node supervisor에서 native PTY 생성 | engine IPC disconnect, 정상 close, 취소, lifetime timeout에 group 정리 |
| Windows | `WindowsJobCommandBackend` + `WindowsJobHostPort` orchestration 계약 | 실제 native Job Object binding이 없으면 명시적 unavailable; POSIX·taskkill fallback 없음 |
| 격리 sandbox | 이 backend에 없음 | capability `isolation:host-user`, `fileIsolation:false`, `networkIsolation:false` |

POSIX group 정리는 해당 process group의 관찰에 근거한다. interactive shell에는 먼저 SIGHUP을 보내 별도 job group에 hangup을 전달한다. shell이 스스로 종료하면 Linux·FreeBSD에서는 `ps`의 session id로 PTY session에 남은 job group을 찾아 같은 방식으로 정리하고, 남은 구성원이 없을 때만 정리를 확인한다. macOS `ps`는 session id를 제공하지 않으므로 정상 종료 시 원래 group만 관찰하며, 종료하는 shell이 HUP를 보내지 않는 job(`disown`, `&!`, `NO_HUP`)은 이 경계 밖이다. 다른 session으로 탈출하거나 HUP를 무시하는 사용자가 직접 시작한 daemon까지 강제 격리하는 기능은 제공하지 않는다. 이 경계를 파일/네트워크 sandbox 또는 모든 프로세스의 포괄적 추적으로 표시해서는 안 된다.

## Host API와 수명

`TerminalService({resolveOwner, backend?, journal?, maxDurationMs?})`에서 `resolveOwner`는 현재 host의 session/workspace/root를 확인한다. 터미널 cwd는 `realpath` 이후 그 workspace 안이어야 한다. 파일·argv는 shell command 문자열과 분리해 native spawn에 전달한다. 전달 환경은 command와 동일하게 provider credential 및 engine secret 이름을 제거한다.

`create`, `get`, `list`, `attach`, `write`, `resize`, `replay`, `cancel`, `close`를 제공한다. 다른 session/workspace owner 또는 `authority:model`은 PTY 접근 전에 거부한다. attach 해제는 사용자 terminal을 종료하지 않는다. terminal 종료는 final state event 뒤 stream을 닫는다. 이미 종료된 기록에 attach하면 history snapshot만 반환하고 event stream은 끝난다. engine close는 이미 dispatch한 starting 생성까지 기다린 뒤 소유 process를 취소한다.

기본 상한은 host 전체 활성 terminal 16개, session당 4개, 보관 history 128개, terminal당 attach 4개, UTF-8 ring 256 KiB, output event 16 KiB, attachment 대기 64 KiB, 단일 write 16 KiB, pending write 4개, 수명 1시간이다. buffer는 오래된 event부터 제거하며 `oldestSeq`, `nextSeq`, `gap`, `hasMore`로 replay 누락을 명시한다. Unicode code point를 중간에서 잘라 replacement character를 생성하지 않는다. 느린 attach가 대기 상한을 넘으면 그 attach만 `TERMINAL_ATTACH_BACKPRESSURE`로 닫힌다.

`MemoryTerminalJournal` 또는 선택적인 `SqliteTerminalJournal`이 bounded history를 보관한다. terminal 기록에는 live PID를 넣지 않는다. 재시작 시 `starting/running` 기록은 `interrupted`, `reason:engine_restarted`, `cleanupConfirmed:null`로 전환하며 과거 프로세스에 재접속하거나 커맨드를 재실행하지 않는다. 종료가 관찰되지 않은 backend와, fork 이후 시작에 실패하고 정리를 확인하지 못한 backend는 `uncertain`으로 기록한다. 저장된 output은 살아 있는 PTY의 증거가 아니다.

## Native dependency 준비

`node-pty`는 optional dependency다. 없는 패키지, 다른 ABI, 실행 불가 helper는 PTY capability unavailable로 반환된다. macOS stable 1.1.0의 prebuilt spawn-helper 실행 비트 누락은 [upstream issue](https://github.com/microsoft/node-pty/issues/919)에 보고되어 있다. `node scripts/prepare-pty.mjs`는 해당 선택 패키지의 regular helper file 실행 비트만 명시적으로 정리한다. engine runtime은 dependency 파일의 권한을 변경하지 않는다. Electron 패키징 및 ABI 검증은 이 headless 검증에 포함되지 않았다.

## 검증과 남은 OS 증거

2026-10-07, 이 macOS arm64 / Node v26.9.0에서 `terminals.test.ts` 12/12를 통과했다. 실제 tty 확인, input 전달, resize 후 `stty size`, 자연 종료, inherited child tree의 취소·close 정리, supervisor IPC disconnect, engine parent 실제 SIGKILL 이후 group 정리, interactive zsh의 별도 background job group 종료를 관찰했다. owner, cwd symlink, buffer/cursor, attach count/backpressure, history 재시작 및 starting-close 경합도 별도 검증했다.

`backends.test.ts`는 Windows native port의 suspended spawn→assign→ownership record→resume 순서, unassigned child 정리, cancellation, retained descendants, 잘못된 native count, close 실패, 늦게 도착한 handle을 fixture로 확인한다. 이 fixture는 Windows OS 증거가 아니다. 실제 Windows Job Object child-tree timeout·engine crash 검증은 명시적 skip이다. Linux에서는 실제 테스트를 실행하지 않았고 플랫폼 코드를 구현한 상태다. **E5-08은 native Windows binding 및 실제 Windows 검증이 남아 있어 완료 상태가 아니다.**
