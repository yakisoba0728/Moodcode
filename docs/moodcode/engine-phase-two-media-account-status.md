Moodcode 실제 미디어 계정 검증 — 2026-10-09

현재 **79/80 작업·19/20 기능군**이다. 선택한 `gpt-audio-1.5`의 오디오 관측 조건은 충족했지만 `gpt-4.1-mini` 영상 프레임 답이 기대 색상과 달라 MC2-16d를 완료하지 않는다. 각 실제 실행은 baseline `7ab91d5` 위 working tree의 원본 구현 및 compiled runtime SHA에 결속한다. 후속 커밋에 포함됐다는 사실만으로 다른 소스 버전의 계정 검증을 주장하지 않는다.

실제 생성 요청은 총 **11회**, 공식 모델 목록 GET은 별도 1회다. 자동 재시도는 없다. 각 실행의 상한은 audio 3회·video 1회·all 4회이며 Turn당 provider Attempt는 1회다. [요청 원장](engine-phase-two-media-account-request-ledger.json)은 실패 이력을 덮어쓰지 않고 각 보고서 SHA와 요청 수를 기록한다. 모델 목록에 있다는 사실은 생성 성공 증거가 아니다.

| 선택한 경로 | 실제 관측 | 판정 |
| --- | --- | --- |
| Chat 오디오 출력 | 완료 WAV Artifact 153,644 bytes, native Part/Attempt·usage·cleanup | 관측 충족 |
| 재시작 후 새 세션 오디오 입력 | 생성 WAV SHA 유지, 임의 단어 3개 exact 인식, 예상 답이 요청 전체 plaintext에 없음 | 관측 충족 |
| 오디오 중복 | 원래 Input·Run·Part·Attempt snapshot 동일, 추가 요청 0 | 관측 충족 |
| 첫 실제 media delta 이후 취소 | 부분 WAV Artifact 19,244 bytes, complete=false, native cancelled·cleanup confirmed | 관측 충족 |
| audio/video admission 거부 | 선택 모델별 MIME·초과·unknown capability·source deletion 4개씩, 요청 및 Attempt 0 | 관측 충족 |
| Responses 영상 | native Run completed지만 exact 색상 답 불일치 | 미충족 |
| 영상 성공 입력 중복 및 후속 paused archive/import | 실제 전체 실행이 영상 불일치에서 종료되어 미실행 | 미검증 |

[실제 전체 실행](engine-phase-two-media-account-expiry-profile-failure.json)과 [독립 오디오 검토](engine-phase-two-media-audio-account-independent-review.json)가 위 관측을 확인한다. 전체 `accountVerified`와 각 사례의 계정 완료 표시는 false다. 오디오 관측의 부분 성공을 전체 작업 완료로 바꾸지 않는다.

실제 Chat 오디오 스트림에는 정상 오디오·expiry·usage·DONE이 있고 `finish_reason`이 없었다. `OpenAICompatibleProvider`의 호스트 호환 옵션은 기본 비활성이며 다음 좁은 조건만 허용한다.

- `includeStreamObfuscation`: 명시했을 때만 stream option을 전송한다. 실행기는 false를 선택한다. 이 설정만으로 문제를 해결했다고 주장하지 않는다.
- `allowEmptyAudioMetadata`: 선언된 exact 오디오 모델과 앞선 정상 프레임의 id/object/created/model tuple에 일치하는 제한된 scalar metadata 프레임만 허용한다. error·unknown field·tuple drift는 기존 오류다.
- `allowAudioExpiryCompletion`: 선언된 오디오 출력·동일 tuple·실제 PCM·expiry·유효 usage·DONE·도구 호출 없음이 모두 확인된 경우에만 누락된 finish를 stop으로 정규화한다. text recognition·unknown model·length·누락 조건은 허용하지 않는다.
- `onMalformedStream`: 원래 실패·정리 동작을 유지하며 구조·유형·길이·고정 상태만 제공한다. 원문 응답·remote ID·transcript·base64·header는 기록하지 않는다.

PCM16 24,000Hz·mono·alloy는 명시적 호스트 프로파일이다. Chat 문서가 numeric layout을 보증했다고 주장하지 않으며 Realtime/TTS 사양이나 성공 인식 결과로 공식 근거를 대체하지 않는다. 미디어 token/window 비용은 null이며 unknown cost의 명시적 허용을 기록한다.

영상 실패 후 실행기는 native 완료와 의미 검증 통과를 구분하고, 비교 전에 해시·문자 수·token 수·고정 색상/other 진단을 저장한다. Unicode 문장부호는 단어 경계를 보존하는 공백으로 바꾸고 숫자·추가 단어·색상 순서는 유지한다. 로컬 검사 20개가 통과했으며 comma 구분 통과와 순서·숫자·추가 단어 실패를 실제 native/HTTP 경로로 확인했다. [독립 검토](engine-phase-two-media-recognition-independent-review.json).

[실제 영상 실패 진단](engine-phase-two-media-account-video-recognition-failure.json)은 24자·token 3개 모두 other이며 native cleanup과 소스/runtime 불변을 확인했다. [오프라인 native 검사](engine-phase-two-video-wire-offline-verification.json)는 같은 AVI SHA·해당 runtime SHA에서 PNG 3개가 각각 8×8 RGB이고 모든 픽셀과 0/500/1000ms 순서, Responses image 데이터 및 assistant 문자열이 보존됨을 확인했다. 이 검사의 공급자 네트워크·credential·실제 계정 호출은 0이다. [독립 검토](engine-phase-two-video-wire-independent-review.json).

실제 upstream 답 원문과 닫힌 DB는 보존되지 않아 동의어·언어·모델 인식 원인을 확정할 수 없다. 실패를 성공으로 정규화하거나 모델 답이 맞을 때까지 반복 호출하지 않는다. 영상 의미 검증, 성공 입력의 duplicate, 전체 성공 후 paused archive/import가 남아 있다. PDF·Anthropic·다른 계정/모델·Codex 새 audio/video/output·정확한 미디어 비용·Windows native engine 지원은 이 증거에 포함하지 않는다. E5-13·E5-08·E6-07·E6-08을 열린 별도 이월 항목으로 유지한다.
