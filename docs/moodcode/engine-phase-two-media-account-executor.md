Moodcode native media account verification executor

완결된 기능 단위로 분담한 planner와 실제 엔진 검증 실행기를 통합했다. 구현 담당은 실행기·회귀 검사를 함께 동결했고, 별도 검토 담당은 최종 파일 SHA 기준으로 기존 6개 결함 수정과 종료 실패 회귀를 확인했다. Root는 동일 파일로 타입 검사, planner/실행기 소스·컴파일 검사, 전체 엔진 회귀와 평가를 실행했다. 구체적인 결과와 파일 해시는 [검증 기록](engine-phase-two-media-account-executor-verification.json)에 있다.

기본 명령은 `npm run verify:media`다. 빌드 후 계획만 반환하며 API 키를 조회하거나 공급자 요청을 보내지 않는다. 로컬 회귀 명령은 `npm run test:media-verification`이다.

실제 실행은 기존 native Engine/Run/Turn/Attempt/Part/Artifact 경로를 사용한다.

- 오디오: 임의 단어 3개를 생성하도록 요청해 실제 PCM/WAV Artifact를 저장하고, 엔진을 재시작한 뒤 새 세션에서 해당 WAV를 인식한다. 인식 요청 전체 plaintext에 예상 답이 없는지 확인한다. 별도 세션에서는 첫 media delta 이후 취소해 부분 Artifact·실패 Part·iterator 정리를 확인한다.
- 비디오: 임의 색상 3개의 AVI를 실제 디코더로 PNG 프레임 3개와 시각 0/500/1000ms로 변환하고, 별도로 선택한 Responses 모델의 실제 답을 비교한다. native 비디오를 공급자가 직접 이해한다고 주장하지 않는다.
- 각 선택 경로에서 잘못된 MIME, 상한 초과, 미확인 capability, 원본 삭제를 정확한 native 오류 코드와 요청 0으로 확인한다. 중복 입력, 재시작, archive/import paused 및 요청 재실행 없음도 검사한다.
- 오디오 3회·비디오 1회·전체 4회가 최대 요청 수다. 각 Turn의 공급자 Attempt를 1회로 제한하고 자동 재시도하지 않는다. usage와 미디어 비용이 미확인인 경우 null로 남긴다.
- 원본 구현과 실제 실행된 engine/contracts 런타임 파일을 별도로 고정·재검사한다. native 정리 증거 부족, 종료 실패 또는 소스·런타임 변경 시 DB와 Artifact를 보존하고 모든 계정 완료 표시를 철회한다.

실제 오디오 실행에는 exact 모델, 환경 변수 이름, host가 확인한 PCM sample rate/channels·voice·근거를 명시해야 한다. 아래 값은 사용자가 선택·확인한 값으로 채운다. 키 원문은 명령 인자로 받지 않는다. CLI에는 startup hook이 없어야 하고 공식 OpenAI HTTPS 경로의 실제 응답만 계정 증거로 인정한다.

```sh
npm run verify:media -- --live --scenario audio \
  --audio-model EXACT_AUDIO_MODEL --api-key-env ENV_NAME \
  --declare-audio-input-output --pcm-sample-rate DECLARED_RATE \
  --pcm-channels DECLARED_CHANNELS --voice DECLARED_VOICE \
  --capability-reference HOST_LAYOUT_REFERENCE \
  --allow-unknown-media-token-cost --max-requests 3 \
  --report /absolute/new-audio-report.json
```

비디오만 검증할 때는 `--scenario video --video-model EXACT_IMAGE_CAPABLE_RESPONSES_MODEL --declare-video-frames --max-requests 1`과 공통 live/API 환경 변수/capability 근거/unknown-cost/report 옵션을 지정한다. 전체 실행은 audio/video 옵션 모두와 `--scenario all --max-requests 4`를 지정한다. report는 기존 파일을 덮어쓰지 않는다.

[gpt-audio-1.5 공식 모델 설명](https://developers.openai.com/api/docs/models/gpt-audio-1.5)과 [Chat 오디오 가이드](https://developers.openai.com/api/docs/guides/audio-chat-completions)는 지원 후보를 판단하는 근거다. 계정 접근 가능 여부나 PCM layout을 증명하지 않는다. 이 모델에는 이미지/비디오 인식 지원이 없으므로 비디오 프레임 검증에는 별도 모델이 필요하다. 현재 Moodcode Codex 인증 경로는 새 오디오/비디오/output을 지원하지 않는다.

실행기 최초 통합 당시 실제 계정 호출은 0회였다. 당시 전체 직접 소스 회귀는 이전 1bff025 통합 범위, planner/실행기 직접 소스 검사는 15개 범위이며 engine/contracts/harness 소스는 1bff025와 같았다. 이 과거 검증은 이후 변경의 전체 회귀 증거로 확대하지 않는다. 로컬 HTTP 응답, runtime 주입, 실제 Codex 이미지 검증의 이전 증거에는 새 미디어 계정 완료 점수를 주지 않는다.

2026-10-09 실제 계정 검증은 [최신 기록](engine-phase-two-media-account-status.md)을 따른다. 공식 모델 목록 GET 1회와 provider 요청 11회를 구분했다. 오디오의 완료 출력·새 세션 인식·중복·실제 부분 취소 관측은 충족했지만, 영상 의미 검증 실패로 전체 MC2-16d는 미완료다. 인증 환경 변수 값과 HTTP 인증 헤더는 보고서에 기록하지 않는다.

진척은 **79/80 작업, 19/20 기능군**으로 유지한다. MC2-16d는 실제로 선택한 지원 계정/모델의 오디오·비디오·생성 출력 검증이 남아 있다. 오디오만 성공해도 전체 MC2-16d를 닫지 않는다. E5-13·E5-08·E6-07·E6-08은 기존 이월 상태를 유지한다.
