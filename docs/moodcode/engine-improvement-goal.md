# 메인 엔진 지속 개선 목표

2026-10-07 사용자가 잠든 동안에도 goal을 활성화해 자체 엔진의 구현·수정·최적화·검증을 계속하도록 요청했다. 실제 진행 상태는 루트 `TODO.md`의 G1 항목과 검증 보고서를 기준으로 한다. GUI는 실행하지 않는다. 기존 로컬 Codex 인증을 사용하는 검증은 임시 저장소와 제한된 fixture 작업만 대상으로 한다.

## 비교 근거와 구현 방향

| 대상 | 확인 범위 | Moodcode에 반영할 문제 |
| --- | --- | --- |
| OpenCode | 공개 엔진 소스 `4ac0d9c3d169bbe81d9570013effdda3fe24d36e` | 긴 실행의 이력 선택·도구 결과 축소·provider 동작 |
| pi | canonical 공개 저장소 `ae92585d3b3e5f1e4b123d14a34314d826d8d9f5` | 초기 목표와 완전한 최근 exchange 보존·확장 경계 |
| Amp | 공식 models/subagents·plugin 문서 | 별도 child 문맥과 제한된 최종 결과 |
| Claude Code | 공식 sub-agents 문서 | 역할별 도구 허용목록·worktree·부모/child 수명 |
| Codex | 공개 Rust 엔진 `0b863c69f50335acd92164aab971cb58d298c2fe`와 공식 문서 | 사용자 anchor·미디어 보존·shared budget·사용량 관측 |

공개 소스에서 관찰한 문제와 동작을 기준으로 독립 계약·구현·fixture를 만든다. 원본 구현, 프롬프트, 도구 설명, 테스트를 복사하거나 비공개 실행 파일의 내부 엔진을 추정하지 않는다. [이력 조사](research/2026-10-07-context.md), [위임 조사](research/2026-10-07-delegation.md), [미디어 조사](research/2026-10-07-media.md), [Codex 비교](research/2026-10-07-codex.md)를 따른다.

## 반복 작업 단위

첫 단위는 bounded 이미지 입력, 승인된 읽기 전용 모델 위임, active Run 이력 선택, durable attempt 사용량이다. 담당자가 자체 테스트를 수행하고 다른 담당자가 실제 엔진 연결을 독립 검토한다. 통합 문제를 수정한 뒤 전체 headless gate, fixture 평가, 제한된 실제 Codex 과업을 실행하고 로컬 커밋으로 검토 지점을 남긴다.

후속 단위는 명시적인 이미지 이력 보존/생략 정책, 디스크 사용·orphan 진단, 복합 child/도구 실제 모델 과업, 실패·재시작·cleanup 경계와 필요한 최적화다. 누락된 usage를 0으로 만들거나 미확인 effect를 성공으로 간주하지 않는다. 성능 숫자는 측정 조건과 표본을 함께 기록한다.

Windows native Job backend, 다른 OS 호스트, 최초 hosted CI, 실제 Anthropic 계정 검증은 해당 환경이나 계정이 없으면 완료 처리하지 않는다. Git remote는 현재 없다. 새 외부 연결·발행·유료 서비스 설정은 임의로 만들지 않는다. 이 제한이 있어도 진행 가능한 로컬 엔진 작업은 계속한다.
