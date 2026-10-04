# Moodcode 구현 순서

갱신일: 2026-10-04, Asia/Seoul. 사용자는 Electron과 자체 엔진, GUI보다 엔진을 먼저 구현하는 순서를 확정했다. E0~E4의 엔진 소스와 추가 서비스를 병렬 구현하고 fixture 통합 검증을 완료했다. E2의 실제 공급자 계정 호출은 남아 있다. 아래 계획의 완료 조건과 [실제 구현 상태](./implementation-status.md)를 함께 확인한다.

## 진행 원칙

먼저 GUI 없이 엔진의 전체 실행 흐름을 검증한다. TypeScript/Node 엔진, 내장 SQLite, 개발용 터미널 harness를 구현했다. harness는 command를 전달하고 event·기록을 보여주는 얇은 실행 도구다. 실행 상태·승인·모델 루프는 모두 engine에 둔다.

첫 공급자가 결정되기 전에도 테스트용 provider로 접수·저장·취소·재시작을 구현할 수 있다. provider는 모델 한 turn의 통신만 담당하고, 여러 turn과 도구 실행을 연결하는 agent loop는 Moodcode가 소유한다. 상세 계약은 [엔진 구현 명세](./engine-spec.md)를 따른다.

기간은 runtime·모델·프로세스 실험 결과 이후 추정한다. 계획의 완료 조건과 실제 통과한 검증을 구별한다.

## 단계와 완료 조건

| 단계 | 구현 결과 | 완료를 판단하는 실행 |
|---|---|---|
| E0: 엔진 기반 | contracts·engine·harness 구성, TypeScript build/typecheck, 테스트 실행, Node·Electron utility runtime 및 SQLite driver 선택 | GUI 창 없이 최소 engine entry와 DB 열기·쓰기·닫기가 두 runtime에서 동작. 버전·lockfile 기록 |
| E1: 기록되는 실행 하나 | workspace/session, input/run admission, 테스트용 model stream, 상태 전이·취소, SQLite journal/projection·snapshot/replay | harness에서 요청→접수→응답→완료. 같은 request ID 재전송, busy, 명시적 중지, 재접속, 프로세스 강제 종료 후 기록 조회 |
| E2: 실제 모델 | 공급자 하나의 adapter, credential 주입, context 구성, text/tool-call/usage 정규화, 오류·AbortSignal | 실제 텍스트 요청과 한 turn의 tool-call 수신. 인증 실패·부분 stream·취소 검증. 공급자가 도구를 직접 실행하지 않음 |
| E3: 읽기와 모델 루프 | list_files/read_file/search_files, tool registry·입력 검증·권한 검사, 결과를 다음 model turn에 반영, 실행 budget | 작은 fixture 저장소를 읽고 검색한 뒤 답변. 잘못된 입력, 한도 초과, 반복 호출, 실행 중 중지 재현 |
| E4: 코드 변경과 검증 | apply_patch/run_command, 요청별 승인·거절, checkpoint·실행별 diff, timeout·출력 제한·process cleanup | 작은 버그 수정→승인→patch→검증 명령→최종 응답. 오래된 승인·외부 편집·부분 실패·기존 사용자 변경·명령 취소·도구 실행 중 crash 검증 |
| E5: Electron 연결과 GUI | engine host·preload bridge, React 화면, OS credential adapter, 세션·승인·diff·설정, 앱 bundle | 개발 설치 없는 macOS 앱에서 E1~E4 흐름. UI reload/창 수명과 Run 수명 분리, utility crash, SQLite/native·프로세스·대량 출력 확인 |
| E6: 확장 | 추가 provider·OAuth, context compaction, 대화형 PTY, worktree 병렬 실행·subagent, MCP 등 선택한 다음 기능 | 각 기능의 실제 backend/OS 계약과 crash·cancel·재접속 검증 |

E0의 Electron 확인은 창을 만드는 작업이 아니다. 엔진이 나중에 실행될 utility runtime과 SQLite의 호환성을 일찍 확인하는 작은 실험이다. 최종 패키징 성공 여부는 E5에서 검증한다. native SQLite driver를 사용하면 Node 개발 환경과 Electron용 모듈의 빌드·배포를 따로 확인한다. [Electron native module 문서](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).

## 첫 구현 묶음: E0~E1

첫 결과는 **한 세션의 입력이 테스트용 모델을 거쳐 기록되고, 중지·재시작 후에도 상태를 조회할 수 있는 엔진**이다. 이 묶음은 실제 모델 API 계정이나 GUI가 없어도 검증한다.

| 작업 | 결과 | 의존성 |
|---|---|---|
| M-001 workspace·runtime | 세 패키지, ESM/TS build·typecheck·test, runtime·SQLite 최소 실험, 버전 고정 | 없음 |
| M-002 contracts | workspace/session/input/run IDs, command/result, event/snapshot, 상태·오류 schema | M-001 |
| M-003 persistence | SQLite migration, 단독 engine owner, request ID 제약, records+journal transaction, snapshot watermark | M-002 |
| M-004 runner | scripted provider, 새 요청 접수, 단일 실행, stream flush, 완료·실패·취소 | M-002, M-003 |
| M-005 harness | JSONL command 입력·접수 결과·event 출력, snapshot/replay, stop·restart | M-004 |
| M-006 장애·경합 검증 | 중복 제출, busy, 늦은 event, 구독 경합, 강제 종료·재시작의 통합 테스트 | M-003~M-005 |

E0~E1에는 실제 파일 변경과 shell 도구를 넣지 않는다. provider/tool 계약의 타입은 이후 기능을 붙일 수 있게 설계하지만, 실행되지 않는 기능을 지원한다고 표시하지 않는다. M-006까지 통과한 뒤 E2~E4에서 실제 코딩 작업을 연결한다.

## 검증에서 빠뜨리지 않을 경계

- **접수/실행:** 같은 session/request ID와 같은 입력은 기존 Run을 반환한다. 같은 ID에 다른 입력은 충돌이다. 중복 여부는 busy 판단 전에 확인한다.
- **동시성:** 같은 workspace의 새 Run은 하나만 실행한다. busy로 거절된 입력은 저장된 실행으로 오인하지 않는다. terminal 기록·정리 전에는 새 변경 실행을 열지 않는다.
- **snapshot/live:** snapshot 조회와 구독 사이에 이벤트를 생성하고, committed journal의 afterSeq 재생으로 누락 없이 복구한다. 느린 소비자가 Run의 완료·중지를 막지 않는다.
- **취소/완료:** 취소 접수와 취소 완료를 구별한다. 늦은 token·완료·tool 결과가 terminal 상태를 뒤집지 않는다.
- **승인/파일:** 승인 대기 중 중지, 승인 직후 외부 편집, 만료 후 도착한 결정, workspace 밖 경로와 symlink를 다룬다.
- **부작용/기록:** 도구 실행 전·중·후 engine 프로세스를 종료한다. 기록과 실제 부작용이 불일치할 수 있음을 보존하며, 불확실한 행동은 자동 재실행하지 않는다.
- **파일 보존:** 이미 수정된 파일과 외부 편집된 파일을 대상으로 diff와 복원을 확인한다. 여러 파일의 부분 실패를 숨기지 않는다.
- **출력/프로세스:** 큰 stdout/stderr에서도 메모리 한도를 유지하고 중지할 수 있다. 긴 명령과 그 자식 프로세스의 종료를 실제 OS에서 확인한다.
- **배포:** Node 개발 실행, Electron utility 실행, 최종 packaged app 실행을 각각 검증한다.

첫 검증은 deterministic provider와 임시 SQLite DB·fixture 저장소를 사용한다. 실제 provider 검증은 별도로 실행하고 비용이 발생하는 네트워크 테스트를 기본 단위 테스트에 섞지 않는다. 테스트 runner는 Node 내장 `node:test`를 우선 제안한다. [Node test runner 문서](https://nodejs.org/api/test.html).

## 이후 기능을 선택하는 기준

변경 검토가 우선이면 E4~E5의 diff·복원·코드 맥락을 다듬는다. 병렬 작업이 우선이면 workspace isolation·checkpoint를 완성한 뒤 worktree별 실행을 추가한다. 구성이 우선이면 provider/tool/agent 설정과 MCP를 확장한다.

첫 공급자와 인증 방식은 E2 전에 결정한다. 엔진 언어·SQLite driver·테스트 runner의 제안은 E0에서 실제 실행과 유지 비용을 확인해 고정한다. 화면 배치와 공개 지원 OS는 GUI·배포 단계의 별도 결정이다.
