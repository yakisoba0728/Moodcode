# 엔진 지속 개선 검증 — 아홉 번째 검토 지점

구현 커밋은 `cc1c42b36ffd0e0e3a9dcf05246454a8dbee12b5`이며 macOS arm64 / Node 26.9.0에서 확인했다. G1-21의 별도 PDF 원본 입력·provider/model 정책·저장/이력/복구 source/보관 경계를 구현했다. Goal은 활성 상태이며 전체 엔진이 완성됐다고 표시하지 않는다. GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency 2 | 2,208개 중 2,206 pass, 실패 0, 취소 0, OS 조건 2 skip; 69,091.5ms |
| fixture 코딩 평가 | 3/3 |
| root 최종 경계 검증 | 78/78 |
| storage 담당 source / 독립 bundle | 각각 74/74 |
| provider/media 담당 source / 독립 bundle | 각각 372/372 |
| 실제 임시 문서 엔진→mock HTTP | 17/17; 위 provider 묶음에 포함 |
| 독립 wiring review source / bundle | 각각 4/4 |
| 같은 source commit 실제 Codex 요청 | 1회 통과; PDF 요청 0회 |

Scoped 숫자는 서로 겹치고 전체 gate에도 포함되므로 더하지 않는다. test manifest를 축소하지 않았다. Linux/Windows·Node24/다른 ABI·hosted CI의 실제 결과로 확대하지 않는다. 원본 command/log SHA·구현 파일 48개의 SHA는 [검증 JSON](engine-goal-verification.json)에 기록했다.

## 구현과 실제 경계

PDF는 이미지와 별도 `documents` 참조이며 input/Run/user Message/inbox exact retry에 결합한다. host import의 owner/hash/CAS/blob, 한 요청 1개/512KiB와 이미지 합산 decoded 1MiB, 별도 base64 직렬화 cap을 검사한다. DB8은 latest-document user partial index만 추가하며 기존 v1/v2 payload·usage/cleanup/ACK와 digest를 다시 쓰지 않는다. PDF header signature 검증만 제공한다.

표준 Responses는 provider의 `pdfModelIds`와 엔진 exact model의 `inputFileTypes`를 모두 요구한다. PDF의 실제 page/text token 비용은 unknown이다. 기본값은 거절이며 엔진과 provider의 `allowUnknownDocumentTokenCost:true`가 모두 있어야 제한을 수락한다. absent/unsupported 모델·MIME·token 정책은 새 admission과 credential/fetch 전에 거절한다. Codex PDF는 비활성이다. 현재 text/image 회귀가 원격 PDF 지원의 증거는 아니다.

기본 이력은 원본 refs를 보존하고 초과 시 fail closed한다. 명시적인 document-history policy는 최신 PDF 1개, 모든 PDF user의 원문 text, exact omitted refs/content SHA·unavailable provenance를 필수로 보존한다. 숫자 message/Run 순서·현재 완전한 tool exchange, session-wide PDF/image 독립 anchors와 owner를 확인한다. 실제 24개 읽기 exchange 뒤 bounded SQL window에서 이전 원본 PDF를 유지했고 whole-session snapshot은 필요하지 않았다. active-prefix는 PDF user를 보호하고 text-only semantic summary는 PDF source를 거절한다.

복구 source의 document annotation은 원본 native message를 pin한다. 원래 document message/input/promoted input을 변경하면 exact evidence가 거절된다. archive는 primary index·blob·SQL/payload owner·참조를 검사하고 새 물리 binding으로 import한다. storage 진단은 root-input-documents-only이며 자동 삭제하지 않는다. [상세 계약](engine-input-documents.md)을 따른다.

## 발견하고 수정한 문제

실제 temporary host는 엔진 token 정책 true/provider false에서 먼저 admission하는 결함을 드러냈다. 공급자 policy를 순수 metadata로 공개하고 양쪽 explicit 선택을 admission에서 검사하도록 수정했다. 직접 coordinator를 통한 로컬 거절도 credential/fetch 0, 실제 cleanup confirmed와 workspace quarantine 없음으로 확인했다.

독립 검토는 active image를 foreign PDF reservation과 active window에서 두 번 계산하는 문제, DOCUMENT_CONTEXT_LIMIT의 prefix 재계획 누락, dual 외부 image/PDF Run 순서와 beforeRunId 역전을 재현했다. 세 경우의 수정 전 red logs와 수정 후 source/bundle 4/4를 보존했다. 새 prefix 후보의 PDF provenance/source SHA도 같은 새 계획으로 교체됨을 확인했다. Fixture API 가정·타입 이름 오류와 composite noEmit command 오류는 구현 실패와 구분해 JSON에 남겼다.

## 실제 계정 회귀

`verify-provider-recovery.mjs --live`는 도구 없는 private temporary fixture에서 원래 불확실한 결과를 합성했다. 같은 DB8 저장소에서 명시적 fixture ACK·재시작 뒤 새로운 Codex `gpt-6.1-sol` 요청 1회가 READY로 완료했다. 실제 사용량 표본은 input 448/output 5 tokens이고 billedTokens는 unknown이다. 요청 projection은 engine-turn-request-v1, logical bytes 2,617, SHA `a53e4452534a4fe300f17228d6fae23ade9ea23cabcf0b634d56e81f48b3a0e0`다.

원래 outcome/부분 text·reasoning·실행하지 않은 tool 제안과 queue/control을 유지했다. head 1→2 뒤 결정과 exact 역사 retry가 재시작에서도 유지됐고 fullSnapshotReads는 0이다. 실제 새 요청의 natural iterator cleanup proof와 host close를 확인하고 임시 경로를 제거했다. 실제 unresolved 프로젝트 기록에는 ACK하지 않았다. 합성한 원래 결과의 remote cleanup/과금·서버 outcome을 확인했다고 주장하지 않는다.

## 보존과 다음 작업

[여덟 번째 검증 JSON](engine-goal-eighth-verification.json)은 `7a5a844`의 원본 bytes 그대로 보존했다. SHA는 `ecd52023891c8ba527fc5437ecc04d1c23f12c0afcd80d304c95bdd349ebce4f`다. 앞선 G1-19 공유 evidence 예산·숫자 순번/V1 digest 호환과 성능 수치는 [공유 조회 계약](engine-recovery-evidence-read.md) 및 보존 보고서를 따른다.

원격 PDF 인식, 완전 PDF parser·페이지/decompression/token 계산, child 문서 index 재귀 audit, audio/video 및 다른 계정/OS/CI는 현재 완료 범위 밖이다. E5-08/E5-13/E6-07/E6-08을 열린 상태로 유지한다. 다음 G1-22는 managed child 저장소의 실제 owner/manifest/path를 확인하고 bounded document audit을 구현하는 로컬 엔진 작업이다. [TODO](../../TODO.md), [지속 개선 목표](engine-improvement-goal.md), [host API](engine-host-api.md)를 따른다.
