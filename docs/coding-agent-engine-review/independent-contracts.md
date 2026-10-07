# 후속 독립 구현에서 유지할 엔진 계약

이번 분석의 신규 후보는 Moodcode 자체 엔진에 맞춰 계약을 설계한 뒤 구현한다. 이 문서는 모든 후보의 공통 수용 기준이며, 아직 새 기능을 구현했다는 표시가 아니다. [현재 기준](moodcode-baseline.md)과 [분석 원칙](analysis-protocol.md)을 따른다.

## 기존 엔진과 결합하는 조건

| 경계 | 수용 조건 |
|---|---|
| source identity | 현재 workspace·session·Run·Turn/Attempt와 입력·파일 hash·설정 revision을 구분한다. 파생 기억·지도·설계안은 현재 파일 상태의 증명이 아니다. |
| provider boundary | context·선택 tool schemas·output reserve·model capability를 같은 capture에서 계산한다. 모델 역할 전환과 동일 요청 재시도를 구분하고 원래 request SHA를 보존한다. |
| authority | 조회·plan·hook·지도·memory·팀 메시지가 새 쓰기/명령 권한을 부여하지 않는다. 기존 Plan/Build·deny·profile·승인 fingerprint를 유지한다. |
| persistent state | 사용자 입력·도구 실행·제안·검증·모델 단계는 각각의 identity와 결과를 저장한다. crash 뒤 미확정 효과를 성공이나 미실행으로 추정해 replay하지 않는다. |
| cancellation | 부모·child·모델·명령·hook의 중지 의도와 실제 정리 관측을 구분한다. 정리를 증명하지 못하면 기존 uncertainty 격리를 유지한다. |
| budgets | 파일수·bytes·시간·모델/도구 시도·child 상한을 적용하고 누락·미지원·unknown을 표시한다. helper나 repair 단계도 같은 실행 예산에 포함한다. |
| bounded projection | 원본 journal/artifact를 보존하고 모델에게 전달할 표현만 제한한다. 최근 완전 exchange·필수 user anchor·이미지/PDF 원본의 기존 정책과 충돌하지 않는다. |
| host ownership | 실행 파일·provider credentials·parser/validator/hook 등록·remote runtime은 명시적 host가 소유한다. renderer/model이 임의 경로를 설치·실행하게 연결하지 않는다. |
| review and conflict | stale 파일·제안·승인을 검출하고 외부 편집을 보존한다. 여러 파일의 적용과 복원이 전부 원자적이라고 약속하지 않는다. |
| evidence | syntax/lint/test/model assessment·exit code·cleanup·Git commit을 서로 다른 결과로 기록한다. skipped/unsupported/timeout/unknown을 passed로 승격하지 않는다. |

## 구현 순서를 정할 때

저장소 문맥·검증 워크플로처럼 기존 context/tool/diagnostic 포트에 추가할 수 있는 기능과, proposal overlay·팀 mailbox처럼 별도의 영구 상태와 복구 명세가 필요한 기능을 구분한다. 이미 있는 기능의 새 이름을 추가하는 작업은 엔진 기능 확장으로 세지 않는다.

먼저 후보의 host API와 versioned 저장·projection을 정하고 기존 계약을 보존하는 독자 fixture를 작성한다. fake/scripted 검사와 실제 OS/provider 검사 결과를 구분한다. 공급자 호출·GUI·배포 환경이 필요한 수용 기준은 확보한 환경에서 실제 검증한 뒤 완료 표시한다.

원본의 알고리즘 동작과 failure case는 출처로 기록하지만 source·prompt·도구 설명·fixture의 기계적 port를 독립 구현으로 부르지 않는다. 실제 재사용이 필요해지는 경우에는 별도로 재사용 파일·허가 고지·배포 의존성을 식별한다. 이번 patch는 그런 재사용을 포함하지 않는다.
