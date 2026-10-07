# 비교에 사용하는 Moodcode 엔진 기준

엔진 source `464812f7d1af24466f57070663131f5979aeca51`를 기준으로 비교한다. [13개 소스 근거와 SHA-256](moodcode-baseline.evidence.json), [현재 구현 상태](../moodcode/implementation-status.md), [host API](../moodcode/engine-host-api.md)를 함께 따른다. 1차 완료 결과를 새 upstream 테스트 결과로 표시하지 않는다.

| 기존 계약 | 확인한 경로·근거 | 후속 분석에서 구분할 부분 |
|---|---|---|
| engine/host 분리 | `engine.ts` wiring, B01 | 새로운 ACP·원격 host는 별도 연결 범위 |
| queue/steer·pause/resume | `runner/input-scheduler.ts`, B13 | team mailbox·상주 agent의 후속 메시지 계약과는 다름 |
| Run/Turn/Attempt·제한된 재시도 | `runner/turn-executor.ts`, B03 | 설계→편집→검증 역할 전환은 일반 retry와 구분 |
| 같은 도구 capture·문맥 계획 | `runner/index.ts`, B02 | 저장소 심볼 색인·의미 검색과는 별도 기능 |
| exact prepare/approval/effect | `runner/index.ts`, B04 | 외부 hook·fuzzy 편집이 승인 binding을 바꾸면 안 됨 |
| bounded context·semantic memory | `context/service.ts`, `semantic-memory.ts`, B05/B06 | 세션 이력 요약과 프로젝트 간 지속 기억을 구분 |
| plugin tool hooks | `plugins/index.ts`, B07 | prepared/settled metadata 관측이 이미 있음. 일반 lifecycle hook 제안은 추가 계약 |
| agent profiles | `agents/index.ts`, B08 | 모델·tools·지침을 고정할 수 있음. 여러 역할의 영구 workflow는 별도 제안 |
| 로컬 skill·reference 읽기 | `tools/session/skills.ts`, B09 | 자동 학습·쓰기·승인된 기억 publication과 구분 |
| 모델의 read-only child delegation | `child-tasks/delegation.ts`, B10 | host가 만드는 write child·다자 간 메시지·팀 작업 할당과 구분 |
| child 결과 delivery | `child-tasks/index.ts`, B11 | terminal 결과만 root inbox로 중복 제거해 전달. 살아 있는 agent mailbox와 구분 |
| checkpoint·restore | `review/index.ts`, B12 | 이미 실행한 파일 효과 복원과 적용 전 여러 파일의 변경안 overlay를 구분 |

기존에는 MCP·PTY·LSP/formatter·worktree child·budget 상속·artifact paging·image/PDF host 입력·archive/recovery·unknown cleanup 격리도 있다. 각 개별 분석은 관련 Moodcode 소스 경로를 확인한 뒤 어떤 부분을 확장할지 명시한다. 제품의 화면 노출이나 지원 OS/provider 실측이 완료됐다는 뜻은 아니다.

이번 새 비교는 1차 goal을 다시 열거나 G1-30 구현을 시작하는 작업이 아니다. 신규 기능 후보는 후속 구현 제안으로 남기며 기존 열린 OS/provider/CI 작업도 그대로 보존한다.
