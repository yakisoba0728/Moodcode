# Moodcode native engine 첫 통합 검증

검증일: 2026-10-07 Asia/Seoul. 환경: macOS arm64, Node 26.9.0. GUI를 실행하지 않고 자체 fixture와 임시 Git 저장소에서 검증했다.

이 문서는 `94d2a65`까지의 첫 native 통합 기록이다. 이후 child/LSP/artifact/진단 연결과 실제 Codex 모델 검증은 [최종 headless 검증](engine-native-final-verification.md)에 기록한다.

## 확인한 결과

- `npm run typecheck`: 성공.
- `npm run test:engine`: 1,387 tests, 1,385 pass, 0 fail, 2 skip. Windows 전용 process-tree 두 조건은 macOS에서 실행하지 않았다.
- `node scripts/evaluate-engine.mjs`: 작은 산술 버그 수정, 빈 배열 경계 수정, 두 모듈 변경의 세 과업 모두 expected diff 및 Node 검사 성공. 공급자는 fixture `scripted`, 모델은 `local`이다. 실제 계정 사용 결과와 구분한다.
- 실제 JSONL harness에서 queue/steer, 승인 대기, cancel/pause, 명시적 resume 및 같은 workspace의 두 session 경합을 검증했다.
- 실제 coding loop에서 session TODO와 durable 질문·답변, artifact owner와 paging, 프로파일 도구 제한, 승인한 stdio MCP 도구 실행 및 연결 종료를 확인했다.
- context overflow fixture는 같은 durable Turn 안에서 tools 없는 의미 요약을 활성화하고 한 번만 재시도한다. 원본 사용자 transcript를 변경하지 않는다.
- 실제 macOS PTY 입출력·resize·취소·부모 SIGKILL 후 descendant 정리, native 실행 6개 및 archive 2개 강제 종료 경계를 확인했다. 복구 후 자동 provider/effect 재실행은 없다.

## 저장·실행 경계

DB v1 기록과 v1 JSONL 소비자를 유지하면서 schema 2 inbox, Turn/Attempt/Part, ContextRevision, session document CAS를 추가했다. 큰 session의 모델 입력은 bounded SQL query로 읽는다. summary와 retry는 Run 예산 및 accounting에 포함되며 추정 token과 실제 관측 usage를 구분한다. 불확실한 cleanup은 성공으로 정산하지 않는다.

동작과 측정 범위는 [저장 API](engine-storage-v2.md), [성능](engine-storage-performance.md), [archive](engine-archive.md), [실행 backend와 PTY](engine-process-terminals.md)를 따른다. scoped tool runtime의 artifact 보관과 기존 checkpoint/review는 같은 실행 owner identity로 연결된다.

## 첫 통합 시점의 후속 항목

당시 worktree·child task·LSP·formatter의 독립 모듈을 검증했고 실제 부모 엔진의 child 예산·실행 연결 및 workspace 변경→LSP 연결, 과거 도구 결과의 artifact 참조 투영·통합 진단·CI는 후속으로 남았다. 이후 구현 상태는 최신 보고서를 따른다. Windows native Job Object binding과 Windows 실제 종료 검증은 여전히 미완료다. 이 첫 통합의 테스트 숫자에는 실제 Codex 계정 요청이 포함되지 않는다.

진행 상태의 기준은 [TODO](../../TODO.md)다. 원본 OpenCode 구현·프롬프트·테스트를 복사하지 않고 Moodcode 계약 및 fixture로 구현했다. 외부 의존성인 `node-pty`의 MIT 출처는 실행 backend 문서에 기록했다.
