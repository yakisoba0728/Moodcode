Moodcode selected-model media account verification coverage

원 MC2-16d 종료 조건을 다시 대조하면서 실행기의 누락 두 가지를 보완했다. 이전 `all` 실행은 오디오 경로에만 오류 입력을 적용했고, 영상 중복 입력은 자동 확인하지 않았다. 이전 검증 기록과 실제 계정 증거는 그대로 보존한다.

현재 `--scenario all`은 선택한 오디오와 영상 경로에 각각 MIME/bytes 불일치, 크기 초과, 미확인 모델 capability, 원본 삭제 검사를 실행한다. 각 결과는 실제 modality/provider/model, 정확한 native 오류 코드, 추가 공급자 요청 0·native Attempt 0을 기록한다. 미확인 모델 검사에는 실제 요청한 미등록 모델 ID와 선택 모델 ID를 각각 남긴다. MIME 검사는 지원된 WAV/AVI bytes를 반대 MIME로 선언한 오류이며, 임의 codec 전체를 검증한 것은 아니다.

오디오와 영상 모두 실제 승인된 input payload/request ID를 다시 `input.accept`에 전달한다. 동일 Input·Run identity와 Turn·Part·Attempt·cleanup·usage 전체 snapshot을 비교하고 scheduler 종료 및 추가 HTTP 요청 0을 확인한다. 권한 handle이나 native receipt를 재구성하지 않는다.

- 전체 경로: 오류 입력 8건, 중복 2건, 공급자 요청 최대 4회.
- 영상 단독: 오류 입력 4건, 중복 1건, 공급자 요청 최대 1회.
- 오디오 단독: 오류 입력 4건, 중복 1건, 공급자 요청 최대 3회.

실행 명령과 명시적인 host 설정은 [기존 실행기 문서](engine-phase-two-media-account-executor.md)를 따른다. 각 Turn의 공급자 Attempt 1회, 자동 재시도 없음, 최종 source/runtime 검사, 정리 불확실 시 DB/Artifact 보존과 완료 표시 철회 계약은 유지한다.

[이번 검증 기록](engine-phase-two-media-model-coverage-verification.json)은 변경한 실행기·회귀 검사와 최종 source/compiled 각15개 검사를 증명한다. engine/contracts/harness/package/runtime은 이전 통합과 동일하며, 이전 전체 엔진4642/4640pass/실패0/skip2·타입0·평가3pass는 해당 커밋 범위의 증거로 보존한다. 이번 변경에 전체 테스트를 다시 실행했다고 표시하지 않는다.

계정 요청은 0회이고 **79/80 작업·19/20 기능군, MC2-16d 미완료**를 유지한다. 현재 Codex 어댑터의 새 audio/video 거절 경로, 비어 있는 두 지정 API 환경 변수, 미지정 exact 모델·host PCM 근거와 실제 계정 성공 증거 부재는 [남은 종료 조건 감사](engine-phase-two-media-account-acceptance-audit.json)에 기록한다. E5-13·E5-08·E6-07·E6-08은 별도로 남겨 둔다.
