Moodcode 영상 검증 입력 프로파일과 실제 계정 증거 — 2026-10-09

실제 AVI→native media→PNG frame→Responses 경로의 입력 품질과 무결성 검사를 보강했다. 명시적 `--video-probe-size 128`은 rgb24-128px-v1을 선택한다. 기본값은 기존 8px 프로파일이며 AVI bytes는 유지된다. generic English color-name 프롬프트를 개선했으므로 기본 프로파일의 전체 wire까지 이전 버전과 같다고 주장하지 않는다. 허용 인자는 canonical 8 또는 128뿐이다.

128px 프로파일은 RGB24 3프레임, stride384·프레임49,152 bytes·AVI147,704 bytes이며 기존 source cap 안에 있다. 실제 source의 header/길이/모든 픽셀을 검사한 뒤 저장된 blob·attachment·native Input/Run SHA를 연결한다. fetch 전에 실제 PNG 세 장의 128×128 크기·모든 RGB 픽셀·IHDR/IDAT/IEND CRC·asset/source SHA·0/500/1000ms 시각을 독립 검증한다. CRC 손상 회귀는 변경된 실제 PNG에 맞는 asset SHA를 넣어 digest 검사를 통과시킨 뒤 CRC guard에서 요청0으로 실패하는지 확인한다.

[OpenAI 이미지 입력 가이드](https://developers.openai.com/api/docs/guides/images-vision)는 선명한 입력을 요구하며 모델별 patch 처리에서 작은 이미지를 확대하지 않는다고 설명한다. 128px 선택은 입력 품질을 개선하기 위한 구현 판단이다. 8px가 공식적으로 지원되지 않는다는 최소 크기 규칙은 주장하지 않는다. [gpt-4.1-mini 모델 문서](https://developers.openai.com/api/docs/models/gpt-4.1-mini)의 이미지 입력을 사용하며 native video 입력을 지원한다고 주장하지 않는다.

예상 답은 요청 전체 plaintext에 없으며 결과 비교는 exact 순서와 token 수를 유지한다. 숫자·추가 단어·다른 순서·비영어 답을 성공으로 바꾸지 않는다. 원문 없는 진단에는 고정 색상 종류·other, 문자/코드포인트 수, ASCII/Unicode 분류와 고정 script별 개수만 기록한다. native Run completed와 의미 비교 통과는 별도다.

첫 실제 128px video-only 실행은 gpt-4.1-mini Responses 1요청에서 exact 색상 세 개·순서·native Attempt/Part·usage828/4·cleanup을 확인했다. 성공 입력의 중복은 같은 native identity와 요청0이며 이후 restart/paused archive/import도 요청0이다. source/runtime SHA는 실행 전후 동일하다. [실제 보고서](engine-phase-two-media-account-128px-video-verification.json)는 선택한 영상 scope의 accountVerified=true만 기록한다. 이전 두8px 영상 실패와 직전 all128 오디오 실패는 변경하지 않는다.

구현 담당 source 회귀20/20와 Root의 planner 포함 직접 source26/26·compiled26/26·build0, [동결](engine-phase-two-video-probe-source-freeze.json)·[검증](engine-phase-two-video-probe-verification.json)·[독립 검토](engine-phase-two-video-probe-independent-review.json)를 확인했다. 로컬 HTTP/고장 fixture의 account credit은 false이다. 새로운 hosted media26개 결과는 이후 실제 CI에서 확인한다. [Root 통합 기록](engine-ci-windows-video-local-integration.json)은 로컬 Darwin portable 검사와 실제 OS 결과를 구분한다.
