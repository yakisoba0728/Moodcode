# Phase 2 엔진 진단

`diagnostics/trajectory.ts`, `attempt-manifest.ts`, `stall.ts`는 기존 native journal을 읽는 독립 진단 모듈이다. DB schema를 추가하지 않고, provider·tool·recovery를 실행하지 않는다. 엔진 host API `getTrajectory`, `getAttemptManifest`, `getStallObservation`에 연결되어 있다. 새 command protocol이나 GUI endpoint를 광고하지 않는다.

`exportTrajectory`는 `getSession`과 `readSessionEvents`만 사용한다. native source 페이지 최대 100개, 기본 선택 50개, 출력 기본 64 KiB·최대 256 KiB를 적용한다. source reader 자체의 byte 제한으로 짧은 페이지가 반환될 수 있으므로 전체 세션의 끝을 추측하지 않는다. `sessionFrontier`는 `unknown`이며, `frozenThroughSeq`는 실제 관측한 페이지와 요청 bound 중 작은 값이다. 선택한 Run 이외의 이벤트도 session cursor에는 반영한다. 빈 페이지의 동일 cursor는 자동 polling 또는 실행 재시도의 권한이 아니다.

진단에는 journal/owner ID, 실행 상태, 요청 digest, cleanup 관측, 출력 종류·바이트·digest·partial 여부와 usage snapshot이 들어간다. prompt·tool input/result·reasoning 원문·provider replay·credential 값은 포함하지 않는다. usage는 미관측이면 `null`, 관측된 0은 0으로 남긴다. cached/reasoning 토큰은 inclusive total의 일부다. revision을 합산한 billed total은 만들지 않는다.

`createCodingEvidenceManifest`는 coding Run input/config projection과 선택 journal projection을 결속한다. 한 coding Run 안의 여러 provider Attempt를 개별 관측으로 유지한다. `identitySha256`는 input/config와 선택적 host source 선언을 pin하며, `runProjectionSha256`와 `manifestSha256`는 관측 상태도 포함한다. 이 hash는 서명이나 승인 권한이 아니다. 전체 raw Run·전체 journal hash는 `null`이며, source를 직접 검증하지 않았다면 `not-observed`다. mutable Run 조회와 journal 조회는 별개라고 표시한다. Run `completed`를 검증 통과 또는 task 성공으로 승격하지 않는다.

`classifyDiagnosticError`는 인증·rate limit·context overflow·rejection·transport·timeout·protocol·cancel·cleanup uncertainty를 분류하고 오류 메시지는 제외한다. 실제 retry와 recovery 판단은 기존 runner/receipt owner가 계속 맡는다.

`getStallObservation`는 최대 100개 sample에서 최대 64개 window를 선택하고, tool streaming revision을 한 실행으로 중복 제거한다. 같은 read input/result/source digest와 effect epoch의 완전한 관측이 반복될 때 `possible-stall` advisory를 반환한다. source 변경·effect epoch 변경·결과 변경·host가 확인한 정당한 반복은 신호를 끊는다. 실제 source/effect provenance가 없거나 read effect 분류가 없으면 `unknown`이다. 실행 금지·cancel·tool replay를 수행하지 않는다.

`getTrajectoryStallObservation`는 현재 journal만으로 과거 tool 실행 경계의 source/effect epoch를 만들 수 없으므로 보수적 `unknown`을 반환한다. 다음 작업은 executor 경계에서 실제 provenance를 기록하고 그 observation을 연결하는 것이다. tools-free artifact distillation도 아직 구현하지 않았으며, 검증 receipt와 summary budget을 연결한 뒤 별도 opt-in으로 추가한다. 이 모듈들만으로 MC2-12 전체 완료를 주장하지 않는다.

검증은 실제 SQLite native 기록의 읽기 전후 불변성, 정확한 scope와 range, byte/count cap, 실패한 partial output, unknown usage, secret/replay 제거, provider error fixture, source/epoch 변화와 정당한 반복을 포함한다. 실제 엔진 API의 세션 소속 검사·close 이후 거절·provider/full snapshot/recovery 미호출·검증 전 getter 실행 금지도 확인한다. 신규 테스트 30개와 범위 타입 검사를 통과했다. 실제 모델 요청은 이 검증에 필요하지 않다.
