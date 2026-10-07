# 저장소 문맥·검증 실행·동적 역할 정책 통합

2026-10-07의 W1 커밋 `448e9e0` 다음 통합이다. 이전 goal turn은 실제 엔진 연결·회귀·커밋을 만든 progress였으며, 이번에도 기존 MC2-01~20 전체 goal을 유지했다. 세 agent가 문맥 공급, 검증 실행, 역할 정책을 맡고 root가 실제 엔진·coordinator·child 연결과 통합 검증을 수행했다.

## 실제 변경

`EngineOptions.repositoryContextPolicy`는 고정한 query/paths·선택한 exact UTF-16 ranges·추가 byte slot만 받는다. LSP 관측 또는 host exact range의 원문은 권한 없는 저장소 데이터로 모델 문맥에 들어간다. 필수 user/tool exchange, tool schema, output reservation과 실제 직렬화 크기를 함께 계산한다. ContextRevision에는 원문과 source identity를 저장하고 diagnostics에서는 원문을 제외한다. before-model hook 이후 및 각 native Attempt dispatch 직전에 같은 source/context revision을 확인한다. 재시도 중 파일이 바뀌면 새로운 요청으로 조용히 교체하지 않고 종료한다. 기본 core 21 tools는 유지한다.

`verificationTools:true`는 엔진 소유 command producer가 있는 기본 core에서만 `verify_changes`를 추가한다. 호스트가 check ID·명령·canonical cwd·profile revision·시간/출력 제한을 등록하고, idle workspace lease 안에서 세션 check/source path 정책을 CAS 저장한다. Run 시작 시 호스트 범위를 고정하고 첫 검증 준비 때 실제 selected file/Git/ignore manifest로 계획을 만든다. 모델의 첫 코드 수정 이후 검증도 이 현재 source에 결속한다. 원문 모델 입력은 check ID만 받으며 명령·cwd·profile override를 거절한다.

각 호출은 현재 parent profile/discovery catalogue 안의 `run_command`를 준비하고 그 opaque handle을 보관한다. 외부 `verify_changes` 승인 preview에 실제 명령·source·plan/check/command fingerprint가 들어간다. 승인 후 원래 handle의 역할·preflight·source를 소비 없이 재검사하고 기존 실행 경계에서도 다시 확인한다. profile에서 빠졌거나 discovery에서 숨겨진 `run_command`를 우회하지 않는다. 한 check는 원래 Run의 tool/output/time budget 한 번을 사용하고 nested 제한을 낮춘다.

영수증은 실제 command exit/signal, 전후 selected source, 성공한 native checkpoint publication, producer cleanup observation과 그 결속 hash, 물리적으로 읽은 원본 로그의 immutable artifact refs를 보존한다. 로그 read input과 pass/fail/stale/persistence는 다음 모델 tool message에서도 볼 수 있다. exit 0이어도 source 변경·누락된 증거·원본 로그 저장 실패를 통과로 만들지 않는다. cleanup hash는 실제 producer/저장 checkpoint 관측의 결속이며 별도의 OS 전체 정리 증명이 아니다. source 범위는 최대 8개 explicit files이며 전체 저장소 검증이라고 주장하지 않는다.

`RoleResourcePolicyRegistry`는 parent/owned children이 공유하는 호스트 CAS 정책이다. 별도의 generation을 catalogue/prepared fingerprint·판단 영수증에 결속한다. MCP 실제 connection/catalogue/resource tuple을 연결 후 설치할 수 있다. 정책 교체는 기존 prepared/approval을 무효화하고 새 Run에서 새 정책과 exact approval을 요구한다. 이미 실행된 효과를 되돌리는 기능은 없다.

## 검증

- 전체 headless gate: **2,879 tests · 2,877 pass · 실패 0 · 기존 조건부 skip 2**.
- 새 기능 source 13개 파일: **137/137 pass**, 취소/skip/실패 0. 실제 child command는 temp cwd에서도 project loader를 찾도록 absolute tsx import를 사용했다.
- 로그 증거 테스트 1개 파일은 source/dist 각각 **7/7 pass**이며, 최종 전체 gate에도 포함했다.
- TypeScript project 검사 통과, 기존 scripted coding fixture **3/3** 통과.
- actual Engine 15개 검사: frozen repository context, hook/retry 중 source 변경, exact 명령 pass/fail/stale, 승인 거절·stale source effect 0, captured profile 제한, model override 거절, idle CAS, 수정 후 최초 plan, native user cancel의 pending/uncertainty 보존, default 21 core.
- 실제 loopback HTTP MCP와 독립 child worktree/DB: 정책 교체·연결 교체 후 오래된 승인 RPC/command effect 0, 새 deny 적용, 새 allow에서 새 승인 및 정확한 child 파일 효과.
- SQLite CAS/restart/archive pause, original log artifact, bounded receipts/index, ownership/clone/mutation/source/cwd/preflight/late publication 검사 포함. 상세 source/log hash는 [검증 기록](engine-phase-two-w2-verification.json)에 고정한다.

## 진행표와 남은 범위

이번에 MC2-01c, MC2-02a, MC2-11d를 추가 완료했다. **12/80 작업, MC2-11 한 범위 완료, 전체 goal은 active**다. 원본 19개 저장소 분석과 1차 검증 기록은 과거 source의 증거로 유지한다.

MC2-01d의 real semantic language server/큰 corpus 품질·자동 관련 path 선택은 남았다. MC2-02b는 실제 typed command 결과와 영수증을 연결했지만 native 취소 및 unsupported 경로의 종료 관측을 더 보강해야 한다. 현재 native user cancel은 active/CAS publication guard 때문에 consumed intent를 pending으로 남기고 Run을 `CLEANUP_UNCERTAIN`으로 종료한다. 명시적 terminal recovery는 이 기록을 outcome 없는 uncertain으로 변환하며 명령을 재실행하지 않는다. 이 경계가 정리되기 전 취소 검증의 완전한 성공을 주장하지 않는다.

MC2-02c/d의 bounded repair·무진전 판정·required receipt completion gate·복구 판단은 다음 작업이다. legacy Run.completed는 실행 loop 종료 의미이며 아직 task 성공 판정이 아니다. MC2-03 이후 다른 범위도 원래 계획대로 남아 있다. GUI·live provider·외부 MCP 운용·Windows·CI/서명 등의 별도 환경 검증과 기존 E5-13/E5-08/E6-07/E6-08 이월은 완료하지 않았다.
