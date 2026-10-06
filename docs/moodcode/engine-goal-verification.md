# 지속 개선 첫 묶음 검증

2026-10-07, macOS arm64 / Node 26.9.0. 구현 commit은 `64435d705ea6e68d7e3502d64d4fd1f2976004ae`다. [기계 판독 결과](engine-goal-verification.json), [목표](engine-improvement-goal.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,646 tests / 1,644 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 확인 |
| 실제 Codex 기본 coding 과업 | read_file→승인 apply_patch→승인 run_command, 변경·테스트·cleanup 확인 |
| 실제 Codex 확장 과업 | 승인된 parent→read-only child→동일 요청 재사용, 이미지 red 인식 2/2 |

실제 모델은 기존 로컬 Codex 인증의 `gpt-6.1-sol`이다. 위임은 child의 실제 DB에서 완료 read_file 1회를 확인하고 결과의 자동 inbox 전달·병합이 없음을 확인했다. 이미지 인식은 자체 생성한 64×64 빨간 PNG와 도구 없는 응답으로 검증했으며 원본 bytes가 transcript/context에 저장되지 않았음을 확인했다. 모든 과업은 임시 저장소에서 실행하고 정리했다. 다른 모델·계정·provider에 결과를 확대하지 않는다.

## 구현과 독립 검토

- DB3의 latest-per-attempt usage: 반복·부분·safe retry·provider 실패·취소·native/v1 journal 실패·terminal 불변·재시작·archive.
- bounded active history: 1k/10k SQL window, 실제 36턴/560개의 서로 다른 완료 read, 8KiB context의 24턴/92개 완료 read, 초기 목표·latest steer·완전 exchange·원본 replay 보존.
- immutable image store와 transport: owner/CAS/hash/MIME/container/size/animation/symlink/close·archive, 실제 admission/context/provider 연결, unsupported 입력/출력 거부.
- delegate_task: 요청별 exact approval·pinned committed snapshot·읽기 도구·부모 잔여 budget·취소·중복·효과 잠금·복원·초기화 수명.

독립 검토는 이미지의 text-only 의미 요약·extractive pruning·receipt 재조회, live Run 전체 exchange의 조기 필수화, archive worktree path, async configureChild 반환 문제를 발견했다. 수정한 뒤 교차 fixture와 전체 gate를 통과했다. [이미지 검토](research/2026-10-07-image-integration-review.md), [위임 검토](research/2026-10-07-delegation-review.md), [실제 loop 측정](research/2026-10-07-accounting-review.json)을 따른다.

마지막 전체 gate의 한 실행은 exit 137로 중단되어 성공 결과로 사용하지 않았다. 종료 원인은 확인하지 못했다. 같은 최종 source의 재실행이 1,646개 전체를 통과했으며 JSON에 이 중단과 완료 실행의 로그 hash를 기록했다.

## 남은 범위

이미지 token 비용은 unknown이며 container 검사는 pixel decoder가 아니다. active-prefix 생략을 의미 요약으로 간주하지 않는다. DB bounded snapshot 밖의 이전 이미지, 더 넓은 명시적 기억 정책, 디스크/orphan 진단은 후속 goal 범위다. 복원 worktree는 ownership 미확인 역사 데이터이며 verify/start/merge/cleanup을 거부하고 fresh 작업은 별도 worktree를 만든다.

audio/video/file 입력, media 출력, 실제 Anthropic 계정, Windows native Job backend, hosted Linux/Windows/Node24 CI, GUI 새 기능 노출은 완료 처리하지 않았다. 현재 Git remote가 없어 hosted CI를 실행하지 않았다. goal은 활성 상태로 다음 구현을 계속한다.
