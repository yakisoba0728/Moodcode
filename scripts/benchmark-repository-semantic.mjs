// Run with node --import ./node_modules/tsx/dist/loader.mjs scripts/benchmark-repository-semantic.mjs [output.json].
// The optional output is actual measurements, never a compiler-response fixture.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativeAvailable, runAuthoredNativeSemanticCorpus, runMoodcodeNativeSemanticProbes } from '../packages/engine/src/repository/fixtures/native-semantic-benchmark.ts';
if (!await nativeAvailable()) throw new Error('Install and explicitly pin native TypeScript 7.0.2 before running this benchmark');
const result = { schemaVersion: 1, observedAt: new Date().toISOString(), authored: await runAuthoredNativeSemanticCorpus(), moodcode: await runMoodcodeNativeSemanticProbes() };
const encoded = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2]) await writeFile(resolve(process.argv[2]), encoded);
process.stdout.write(encoded);
if ([...result.authored.probes, ...result.moodcode.probes].some(probe => probe.score.precision !== 1 || probe.score.recall !== 1)) process.exitCode = 1;
