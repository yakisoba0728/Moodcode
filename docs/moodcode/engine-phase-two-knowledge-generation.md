# W3 지식 생성의 실제 엔진 연결

MC2-03a/b의 다음 통합 묶음이다. 도구 없는 생성은 `knowledgeGeneration: true`를 설정한 호스트만 새로 시작할 수 있다. 공급자 어댑터는 별도 `streamGeneration` 기능을 제공해야 한다. 기존 코딩 실행과 동일한 전송 구현을 사용하되 실제 host-generation/workspace/generation/attempt 식별자를 갖고, 임의 Session·Run·Turn·summary owner를 만들지 않는다.

호스트는 완료한 코딩 실행의 메시지와 정확한 파일을 선택해 원본 source projection을 확보한다. `previewWorkspaceKnowledgeGeneration`의 canonical logical request hash/bytes와 trust/source/target을 pending plan에 고정한 뒤 `generateWorkspaceKnowledge`를 호출한다. 실제 요청은 source를 데이터로 인용한 Moodcode 자체 지침과 정확한 빈 tools 배열을 포함한다. 불투명 capture는 복사하면 권한을 잃으며, 설명 입력은 lease 예약 전에 깊게 복사한다.

독립 budget은 admission 시 저장한 절대 deadline을 사용한다. 한 번만 시도하고 request/inactivity/cleanup/text/other-observation/event 한도를 적용한다. 실제 text bytes를 먼저 계산하고 retained output을 제한한다. reasoning/replay는 관찰 한도에 포함해 버리고 후보나 다음 요청에 넣지 않는다. 실제 usage가 없는 값은 null이다. `finish(stop)` 이후 실제 iterator의 `done`과 확인된 정리가 있어야 완료한다. 반환 실패·지연·`done:false` 및 adapter의 원래 cleanup uncertainty는 durable workspace blocker로 남는다.

생성이 완료돼도 결과는 pending 후보다. 생성 중 source/target/trust가 바뀌거나 원래 deadline이 만료되면 공급자의 실제 완료와 usage를 보존하고 후보만 withheld로 남긴다. `finishWorkspaceKnowledgeCandidate`는 원래 완료 output에서 후보를 마무리하는 명시적 호스트 작업으로, provider를 다시 호출하지 않는다. candidate append 후 marker 저장 전에 중단됐을 때도 실제 generation-owner index로 기존 후보를 찾는다.

DB11은 독립 generation·attempt·recovery acknowledgment·workspace barrier 네 테이블을 추가한다. usage/cleanup은 bounded attempt 안에 함께 저장한다. 기존 코딩·summary 기록으로 generation을 추론하지 않는다. startup은 prepared와 dispatch 이후 상태를 구분해 복구하고 자동 공급자 재실행을 하지 않는다. 원본 preview에 대한 명시적 recovery acknowledgment와 별도 barrier CAS resume는 정리 성공이나 과거 생성 완료를 새로 만들어 내지 않는다. 다른 명령·공급자·summary의 불확실성은 별도로 해소해야 한다. 두 단계 모두 대기 입력을 자동 시작하지 않는다.

archive는 새 row를 제한된 크기로 의미 검증하고 logical hash에 포함한다. import는 원래 generation/attempt/usage/candidate hash와 과거 물리적 binding을 보존하며 workspace 지식을 paused로 남긴다. 원래 native capture나 cleanup 권한을 새 저장소에 재결속하지 않는다.

검증은 source 307개 통과, 전체 엔진 3,272개 통과·실패 0개·기존 Windows 조건부 제외 2개, typecheck 통과, scripted headless fixture 3개 통과다. 실제 Engine subprocess의 create/prepare/dispatch/finish/settle/candidate 여섯 경계에서 SIGKILL 이후 저장된 결과와 자동 재실행 차단을 확인했다. [검증 기록](engine-phase-two-knowledge-generation-verification.json)에 당시 source/test hash와 결과를 고정하며 TODO·진행 JSON의 완료 수는 17/80이다.

아직 publish/revoke, 기존 target revision 관리, 활성 ContextPlan projection과 imported knowledge의 명시적 복구는 MC2-03c/d의 잔여 범위다. 라이브 모델·Windows 실행·GUI·외부 배포 증거는 이번 묶음에 포함하지 않는다.
