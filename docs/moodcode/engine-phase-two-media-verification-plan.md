# Current media verification plan

`npm run plan:media` now describes the implemented WAV input, AVI frame projection and provider-owned PCM output paths. Exact model declarations, host capabilities, unknown media token cost and independently verified PCM layout remain explicit conditions. CLI model selection is DATA and grants no capability.

The bounded account-free planner pins23 current production source files and lists19 pending cases. It imports no provider, reads no credentials/account configuration/environment and performs no network request. Existing `--provider` and `--model` arguments and schemaVersion1 remain compatible. Unsupported codecs, native full-video and image/video generation stay unsupported.

Main CLI regression passes6/6. Separate overlapping native media source/compiled selections each pass13 cases; these are historical worker-scoped checks, not additional live/model evidence. Independent review accepted the final production planner. [Verification](engine-phase-two-media-verification-plan-verification.json) records exact files, original failures and zero-side-effect guards. The [current generated plan](engine-phase-two-media-verification-plan.json) is separate from the preserved original MC2-16a nine-source plan.

Completion remains79/80 work items and19/20 families. MC2-16d still needs actual supported audio/video/generated-output account/model evidence. Two named key variables remain absent at the recorded Root existence-only recheck; values and credential files were not read into the report. Existing Codex image evidence does not grant new-media credit. The original four environment debts remain open.
