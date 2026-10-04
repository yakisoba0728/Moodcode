# Moodcode 엔진 구현 상태

갱신일: 2026-10-04, Asia/Seoul. GPT 6.1 Sol Ultra 세션 10개를 병렬로 실행하고 같은 세션에 추가 구현·검증·수정을 배정했다. GUI 없는 자체 엔진, JSONL harness와 아래 서비스를 구현하고 통합 검증했다. [세션 목록](./implementation-sessions.json), [실행 결과 JSON](./verification-results.json), [실행 안내](../../README.md)를 함께 확인한다.

## 구현 결과

| 범위 | 현재 동작 |
|---|---|
| 계약·facade | schema v1 command/result/event, 엄격한 입력 검증, 엔진 capabilities, 기본 설정과 요청별 override |
| 실행·기록 | workspace/session/request 접수, 중복·충돌·busy 판정, SQLite journal/projection transaction, snapshot/live/replay, 재시작 시 interrupted 처리 |
| 모델·context | Scripted, Chat Completions, native Responses HTTP/SSE adapter; context budget·완전한 tool exchange 유지; reasoning·phase·원본 호출 항목의 durable replay |
| 코딩 도구 | 파일 목록·읽기·검색, hash를 확인하는 파일 patch, 명령 실행, bounded output·timeout·cancel |
| 승인·취소 | 요청별 fingerprint 승인·거절·만료, 늦은 결정·중복 결정 처리, terminal transaction에서 pending 승인 만료 |
| 변경 검토 | checkpoint, Run diff, 외부 편집 충돌 확인, 복원 preview·hash/fingerprint 재검증·실행 잠금 |
| 프로세스 수명 | 별도 POSIX command supervisor, 엔진 강제 종료 시 원래 process group 정리, 불확실한 effect marker 보존·다음 실행 차단 |
| 추가 서비스 | user/workspace 설정 병합, WorkspaceObserver, SQLite integrity·새 파일 backup·closeAsync, 읽기 전용 실행 marker 검사, doctor 진단 |
| 실행 host | JSONL harness의 Responses·설정 연결, 실제 Electron utility process의 SQLite·명령·정리·재오픈 검증 |

기본 실행은 scripted/local의 plan 모드다. build에서도 파일 쓰기와 명령마다 승인을 받는다. 실행 상태·모델 turn loop·도구 호출은 엔진이 관리한다. 설정에는 credential 환경 변수 이름만 저장하고 값은 runtime에서 주입한다.

## 완료한 검증

| 실행 | 결과 |
|---|---|
| `npm test` — strict TypeScript build와 compiled 전체 테스트 | **838개 중 837 통과, 실패·취소 0, Windows 전용 1 skip** |
| 실제 모듈 통합 테스트 | 기존 8개 + native Responses replay 1개, **9/9 통과**; 전체 테스트에 포함 |
| `node scripts/demo.mjs` | 임시 Git 저장소에서 read → patch 승인·적용 → 명령 승인·테스트 → diff·완료, journal 29 events |
| Electron utility smoke | Electron **44.5.1**, 내장 Node **24.21.0**, macOS arm64; 창 0개, 실제 승인 명령·cleanup·checkpoint·SQLite replay·재오픈 모두 통과 |
| Electron Node runtime 검사 | 설정·capabilities·변경 감시·integrity·backup·marker 검사·diagnostics·close/reopen 모두 통과 |
| doctor | 개발 Node **26.9.0**, SQLite **3.53.4**, Git **2.55.0**, workspace 진단 성공 |

통합 테스트는 실제 임시 Git 저장소·SQLite·OS child process를 사용한다. 중복 접수, snapshot과 event 경합, 승인 대기 취소, 외부 편집 충돌, 명령 중지, 강제 종료 후 복구, 사용자 변경 보존을 검증한다. Native Responses 테스트는 loopback HTTP SSE로 reasoning ciphertext·commentary phase·function-call ID·원본 arguments를 도구 결과 앞에 재생하고 SQLite 재오픈 뒤 후속 Run까지 보존되는 것을 확인한다. 실제 공급자 계정 호출은 실행하지 않았다.

최종 읽기 전용 검토 두 건에서 수정이 필요한 blocker를 발견하지 못했다. replay 경로를 로컬 fixture로 다시 확인했고 terminal·approval·backup·facade 관련 41개 테스트도 통과했다. 별도 임시 fixture에서 승인 대기와 진행 중 backup 상태의 `engine.close()`가 backup 정리·승인 1회 만료·단일 terminal 마지막 기록·late allow 거절·새 owner 재오픈까지 완료되는 것을 확인했다.

## 공개 연결 범위

JSONL command는 `engine.getCapabilities`, `workspace.open`, `session.create`, `session.list`, `session.getSnapshot`, `run.submit`, `run.cancel`, `approval.decide`, `review.getDiff`, `events.subscribe`다.

`integrityCheck()`, `backup()`, `WorkspaceObserver`, `getDiagnostics()`, `inspectExecutionLock()`, checkpoint 복원·preview는 engine 패키지에서 사용할 수 있다. 이 서비스의 GUI/JSONL 사용자 흐름은 아직 연결하지 않았다. 복원 호출자는 Run admission과의 경합을 조정해야 한다. 복원 서비스 자체는 활성 Run 확인과 effect lock을 수행하지만 새 Run 접수까지 하나의 원자적 lease로 묶지는 않는다.

## 남은 작업과 한계

- **실제 모델 연결:** 선택한 공급자·모델·계정 권한, 인증 실패와 실제 reasoning/tool calling을 검증한다. 현재 HTTP/SSE 검증은 로컬 fixture다.
- **Electron 제품화:** host/preload bridge, OS credential adapter, GUI와 설치 가능한 앱 bundle을 구현한다. ASAR·fuses·패키징 및 공개 지원 OS 검증은 남아 있다.
- **복구·복원 사용자 흐름:** 불확실한 effect marker를 읽고 확인하는 복구 화면, Run admission과 복원 lease의 결합, 승인·기록을 갖춘 복원 command를 연결한다. marker를 자동 해제하지 않는다.
- **장기 실행 확장:** 대규모 history paging/compaction, OAuth, 대화형 PTY, MCP, worktree 병렬 실행과 제품의 subagent는 후속 범위다.

명령 실행은 현재 POSIX 방식이며 Windows에서는 지원하지 않는다. 원래 process group을 벗어난 daemon이나 명령의 저장소 밖 부작용까지 추적·롤백하지 않는다. checkpoint는 한도 내 텍스트 파일 중심이며 directory·mode·ownership·binary·외부 효과를 완전히 복원하지 않는다. DB backup은 일관된 committed snapshot을 새 파일로 내보내며 원본 DB나 effect sidecar를 대체하지 않는다. 최종 앱 배포의 완료를 의미하지 않는다.

## 추가 작업 배정

| 세션 | 첫 담당 | 재활용한 추가 담당 |
|---|---|---|
| 01 | 계약 검증·context | 설정 파일, provider replay context 연결 |
| 02 | SQLite·journal·복구 | integrity·backup·closeAsync, terminal 승인 만료 transaction |
| 03 | Run coordinator·agent loop | 실제 모듈 경합 통합, native replay 검증·저장 |
| 04 | Scripted·HTTP 모델 adapter | native Responses transport·원본 항목 replay |
| 05 | Workspace·경로·Git | bounded WorkspaceObserver |
| 06 | 파일 목록·읽기·검색 | runtime diagnostics와 doctor CLI |
| 07 | Patch·checkpoint·diff | 복원 preview·fingerprint·잠금·취소 검증 |
| 08 | 승인·거절·만료 | 실제 SQLite lifecycle 경합과 terminal 만료 waiter 정리 |
| 09 | 명령·출력·취소 | supervisor backpressure·강제 종료 수정, marker 읽기 전용 검사 |
| 10 | Harness·Electron runtime | 설정·Responses CLI 연결, 실제 Electron 승인 명령 검증 |

별도 통합 subagent 두 개가 실제 엔진 경로 테스트와 읽기 전용 검토를 수행했다. 모듈별 API·세부 검증·제약은 [구현 보고서](./implementation-reports/)에 남겼다.
