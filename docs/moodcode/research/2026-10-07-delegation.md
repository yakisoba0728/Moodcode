# 모델 요청 위임의 공개 동작 비교

2026-10-07 공개 문서를 확인했다. 문서의 행동 계약만 참고했고 원본 구현·프롬프트·테스트는 가져오지 않았다.

| 근거 | 공개 동작 | Moodcode의 선택 |
| --- | --- | --- |
| [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents) | 자식은 별도 문맥과 도구·권한 설정을 갖는다. 읽기 중심 역할과 worktree 격리를 제공한다. | 별도 엔진·DB·명시적 읽기 도구 목록을 사용한다. 부모의 provider/model/profile을 상속하되 실행 권한을 늘리지 않는다. |
| [Amp models and subagents](https://ampcode.com/docs/models-and-subagents) | 역할별 자식은 별도 문맥에서 집중 작업을 수행하고 최종 요약을 부모에게 돌려준다. 역할의 모델 설정은 부모와 독립적일 수 있다. | 첫 도구는 한 작업을 승인 후 실행하고 크기가 제한된 최종 관측 결과를 tool result로 돌려준다. 모델 변경 입력은 제공하지 않는다. |
| [Amp plugin API](https://ampcode.com/docs/plugin-api) | 맞춤 자식을 모델 도구로 노출할 수 있고 부모 thread 연결·timeout·도구 선택을 설정한다. | delegate_task는 실제 부모 Run/tool 소유권, matching approval, 예약 예산, 취소 신호에 연결한다. 프로그램 API와 모델 권한을 구분한다. |

Moodcode의 첫 구현은 Build 전용이며 정확히 승인된 요청만 한 번 실행한다. prepare는 부모 HEAD commit, 요청, 도구 목록, allocation, profile revision을 고정한다. 남은 시간과 예산은 승인 지문에 넣지 않고 execute 직전에 재검사한다. 기존 호스트 worktree API는 실행 전 maintenance lease를 계속 사용한다. 살아 있는 부모의 모델 도구는 자신의 serial 실행·effect lock 안에서만 Git worktree metadata를 준비한다. 같은 request의 정확한 재요청은 기존 worktree/child를 조회한다.

격리된 파일은 승인에 표시된 커밋 기준이며 부모의 미커밋 변경을 복사하지 않는다. 체크아웃은 per-command Git 설정으로 hook, configured filter, fsmonitor, 자동 maintenance/gc, submodule recursion을 끄고 lazy fetch를 금지한다. 설정 이름·개수·크기 또는 지원 Git 기능을 확인하지 못하면 실행을 거부한다. [Git config](https://git-scm.com/docs/git-config), [Git 명령 옵션](https://git-scm.com/docs/git).

결과는 신뢰하지 않는 관측 데이터다. 자동 input delivery, queue promotion, 파일 병합, Git commit을 수행하지 않는다. 자식 효과 승인은 기존 자식 엔진에서 별도로 유지한다. 초기 모델 도구는 읽기 도구만 선택하므로 효과 도구·추가 위임·네트워크 도구를 요청할 수 없다. filesystem sandbox나 적대적인 외부 Git 설정 변경까지 보장하는 모델로 광고하지 않는다.
