# 문서 원본 입력의 다음 엔진 범위

확인 기준은 Moodcode `42218a82b0975b6d8cfb53e0e458e2493bd8a2c7`이다. G1-19 이후 E5-13의 로컬 구현 범위를 읽기 전용으로 조사했다. 이는 구현 전 조사 기준이며, 이후 `cc1c42b`에서 G1-21 로컬 범위를 구현·검증했다. 현재 계약은 [PDF 입력 명세](../engine-input-documents.md), 검증 근거는 [아홉 번째 검토 지점](../engine-goal-verification.md)을 따른다. 아래 비교는 조사 당시의 상태다.

## 현재 연결과 누락

`packages/contracts/src/index.ts`와 `validation.ts`의 첨부는 PNG/JPEG/WebP/GIF 이미지 refs다. 이미지당 512KiB, 입력당 4개/1MiB이며 `media/store.ts`는 owner·hash·CAS·atomic blob과 세션 32개/16MiB를 관리한다. `engine.ts`의 공개 import도 이미지 전용이다.

`ports.ts`의 resolvedImages, `context/model-spec.ts`의 text/image modality, `provider/responses.ts`의 input_image encoding, `storage/native-history.ts`와 `context/index.ts`의 최신 이미지 보호는 연결돼 있다. 문서 refs·파일 MIME capability·원본 import·history 보호와 input_file 경로는 없다. 표준 Responses의 전체 HTTP request 상한은 기본 2MiB다.

[OpenAI File inputs 공식 문서](https://developers.openai.com/api/docs/guides/file-inputs)는 Responses의 `input_file`, `filename`, PDF data URL을 설명한다. PDF의 텍스트와 페이지 이미지를 처리하는 경로이므로 모델의 해당 입력 지원을 확인해야 한다. 이 공개 API 설명은 고정 Codex backend의 PDF 지원 근거로 쓰지 않는다. API 문서에서 확인한 동작을 참고하고 원본 구현·prompt·tests를 복사하지 않는다.

## G1-21 제안

첫 범위는 **표준 Responses의 명시적 provider/model capability를 갖춘 PDF 원본 입력**이다. 기존 image `attachments`를 union으로 바꾸면 이미지 전용 validator·이력 omission·context 해석이 문서를 오인하므로 별도 `documents` refs와 `resolvedDocuments`를 사용한다.

1. 계약에는 document identity, application/pdf, decoded bytes·SHA refs를 저장한다. file MIME capability의 unknown·명시적 미지원·지원 목록을 구분한다. provider/model 지원과 전체 입력 예산을 dispatch 전에 검사한다.
2. host import와 별도 document CAS index/blob을 추가한다. owner/hash/atomic publication·취소·symlink 경계를 검증하고 archive/storage inspection·재시작에도 연결한다.
3. dispatch 직전에 exact refs와 원본 bytes/hash·canonical base64를 해석한다. 표준 Responses user input_file을 명시적으로 encode하고 미지원 adapter/model은 credential 조회·fetch 전에 거부한다. 원문 bytes는 journal·receipt에 넣지 않는다.
4. bounded SQL/context anchor로 필요한 문서 user를 보존한다. 원본을 text-only summary로 대체하거나 image omission의 pixels 표기를 재사용하지 않는다. exact input retry·logical request proof·recovery source에도 refs를 결합한다.
5. 임시 실제 engine→mock HTTP의 import/inbox/Run/context/encoding·tamper/owner/취소/CAS·archive/restart·unsupported/overflow와 기존 text/image 회귀를 검증한다.

초기 자체 상한 후보는 PDF 1개/512KiB와 image+document decoded 합계 1MiB다. vendor 한도가 아니라 현재 inline request의 메모리 제한에 맞춘 정책이며 실제 구현에서 직렬화 상한도 함께 검증한다.

PDF parser 없이 확인할 수 있는 것은 bounded bytes/hash·최소 signature다. 완전한 PDF 유효성, 페이지 수·압축 해제량·정확한 입력 token과 원격 모델의 문서 인식은 검증했다고 표시하지 않는다. 문서 token 비용은 unknown으로 유지하고 정확한 token 상한 정책을 만족할 수 없으면 typed 오류로 거부한다.

로컬 fixture 범위를 완료해도 실제 API 계정·모델별 PDF 입력은 별도이며 E5-13 전체를 완료하지 않는다. 기존 Codex 계정의 PDF 사용을 지원 기능으로 광고하지 않는다. GUI·새 credential·외부 연결 설정은 이 범위에 포함하지 않는다.
