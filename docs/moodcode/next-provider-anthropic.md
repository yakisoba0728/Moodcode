# E5-13 Anthropic native verification lane

2026-10-09. `scripts/verify-provider-coverage-anthropic.mjs` exports `verifyAnthropicCoverage(options)` for the central provider verifier. It uses an actual Engine, isolated Git repository, SQLite database and artifact directory. The host supplies `api` (engine module with `createEngine`/`createReadTools`), `AnthropicProvider`, `anthropicModelSpec`, exact `modelId`, `apiKey`, `fetch`, `baseURL`, `capabilityReference` and `qualification`. The lane never reads environment variables, account files, GUI state or credentials. It does not choose a default model.

The finite successful lane makes exactly three Messages requests: two native Turns for one `read_file` tool round trip and one fresh Session for image recognition. Every Turn has one permitted ProviderAttempt. A random file value is absent from the first complete wire request and must be reproduced exactly after the actual read tool. A complete authored 384×128 RGB PNG contains three randomly ordered color tiles; every non-image wire string is checked for answer leakage. Output must match the exact three words. Native Run/Turn/Attempt owner binding, completed Tool and Part records, per-attempt positive usage, source-bound stored replay and identical continuation wire blocks are required. Duplicate input delivery in each Session must retain the original native identity and make zero requests.

Reports retain request counts, response status, native failures, original Attempt cleanup receipts, SHA-256 evidence and replay block types. Opaque thinking/signatures, random answers, tool output and keys are not copied into the report. Missing usage or exact recognition failures remain failures even when the native Run completed. Unconfirmed Attempt cleanup or Engine close failure revokes success and retains the isolated directory. Confirmed physical cleanup removes that directory. A response rejected by the capture layer is cancelled within one second before rejection; rejected/unjoinable cancellation remains native `CLEANUP_UNCERTAIN`. The native wrapper also preserves a host capture's original cleanup uncertainty, since that capture can own a body the adapter never received. The lane does not grant `accountVerified`; actual account credit belongs to the central verifier that binds original source, runtime, credential reference and official transport. `accountQualificationEligible` only signals that this lane's evidence is complete under the host's remote qualification.

The public Anthropic adapter remains text/image input, text output and client tools. This lane uses omitted public thinking and records actual replay block types. It makes no account claim for public reasoning summaries, cancelled remote work, PDF, audio, video, generated media, server tools or unsupported model settings. Native thinking replay is observed only when the selected model actually emits thinking blocks.

The original adapter aborted fetch before cancelling an unread HTTP error response. With actual loopback fetch, HTTP 401 then errored the owned reader and replaced the original status with `CLEANUP_UNCERTAIN`. The narrow correction closes the bounded owned body first and always aborts fetch afterward; non-cooperative cancellation still reports uncertainty. The new native loopback HTTP 401 fixture retains `PROVIDER_HTTP_ERROR`, response status 401, one dispatched Attempt and confirmed cleanup.

Official references checked on 2026-10-09:

- [Models overview](https://platform.claude.com/docs/en/models/overview) lists current Claude API IDs `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, and text/image input, text output, tools and adaptive thinking. `claude-sonnet-5-5` is the central lane's planned candidate; it has no account/capability acceptance evidence here.
- [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) documents base64 image source blocks and PNG input.
- [Thinking tool workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows) documents preserving native thinking blocks through tool continuation. Successful replay does not prove every model/configuration combination.

The host inventory reports no Anthropic credential in the approved local credential file or process. Actual Anthropic requests: **0**. The external account condition remains `missing-credential`; the local fixture is not substituted for account evidence.

Verification:

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test scripts/verify-provider-coverage-anthropic.test.mjs packages/engine/src/provider/anthropic.test.ts
```

The final focused source run passed 66 tests (53 existing adapter fixtures and 13 new native lane/probe tests), with zero skips. The new tests make 15 loopback HTTP requests and four injected failure-transport calls in total, bounded to at most three per verification call. They cover exact source Engine execution, native encrypted replay retention, request-owner and model binding, duplicate no-request identity, HTTP 401, truncated SSE, absent positive usage, text/image recognition mismatch, pre-dispatch qualification rejection, actual close-failure retention and confirmed/rejected/unjoinable capture-owned body cleanup. No shared build output or live endpoint was produced by this subtask.
