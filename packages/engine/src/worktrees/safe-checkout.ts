import { EngineError } from '@moodcode/contracts';
import { runGit } from '../workspace/git.js';

export const NO_AUTO_MAINTENANCE = Object.freeze([
  '-c', 'maintenance.auto=false', '-c', 'maintenance.autoDetach=false',
  '-c', 'gc.auto=0', '-c', 'gc.autoDetach=false',
]);

/** Per-command configuration only: never modify a user's Git configuration. */
const BASE = Object.freeze([
  '--no-lazy-fetch', '--no-replace-objects',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'hook.post-checkout.enabled=false',
  '-c', 'hook.reference-transaction.enabled=false',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  ...NO_AUTO_MAINTENANCE,
  '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
  '-c', 'checkout.workers=1',
]);

const SAFE_CHECKOUT_LIMITS = Object.freeze({ configBytes: 32_768, configKeys: 256, drivers: 32, hooks: 64 });

/**
 * Resolve only bounded, ordinary config names. Values (which may contain shell
 * commands) are never read or interpolated. Older Git without no-lazy-fetch
 * rejects this probe before worktree creation and fails closed.
 */
export async function safeCheckoutArguments(root: string, signal: AbortSignal): Promise<string[]> {
  const result = await runGit(root, [...BASE, 'config', '--null', '--name-only', '--get-regexp', '^(filter|hook)\\.'], { signal });
  if (![0, 1].includes(result.code)) throw new EngineError('SAFE_CHECKOUT_UNAVAILABLE', 'Could not inspect bounded Git checkout configuration');
  if (result.stdout.length > SAFE_CHECKOUT_LIMITS.configBytes) throw new EngineError('SAFE_CHECKOUT_CONFIG_LIMIT', 'Git checkout config name bound exceeded');
  const keys = result.stdout.toString('utf8').split('\0').filter(Boolean);
  if (keys.length > SAFE_CHECKOUT_LIMITS.configKeys || !Buffer.from(result.stdout.toString('utf8')).equals(result.stdout)) throw new EngineError('SAFE_CHECKOUT_CONFIG_LIMIT', 'Git checkout config is not bounded UTF-8');
  const drivers = new Set<string>(), hooks = new Set<string>();
  for (const key of keys) {
    const filter = /^filter\.([A-Za-z0-9_-]{1,64})\.(clean|smudge|process|required)$/.exec(key);
    const hook = /^hook\.([A-Za-z0-9_-]{1,64})\.(command|event|enabled|parallel|jobs)$/.exec(key);
    if (filter) drivers.add(filter[1]!);
    else if (hook) hooks.add(hook[1]!);
    else throw new EngineError('SAFE_CHECKOUT_CONFIG_UNSUPPORTED', 'Git checkout config contains an unsupported driver or hook name');
  }
  if (drivers.size > SAFE_CHECKOUT_LIMITS.drivers || hooks.size > SAFE_CHECKOUT_LIMITS.hooks) throw new EngineError('SAFE_CHECKOUT_CONFIG_LIMIT', 'Git checkout driver or hook count exceeded');
  const args: string[] = [...BASE];
  for (const name of [...drivers].sort()) args.push('-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`);
  for (const name of [...hooks].sort()) args.push('-c', `hook.${name}.enabled=false`);
  return args;
}

/** Safe local commit lookup for a delegation preview; no checkout or lazy fetch. */
export async function delegationBaseCommit(root: string, signal: AbortSignal): Promise<string> {
  const result = await runGit(root, [...BASE, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], { signal });
  const commit = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || !/^[a-f0-9]{40,64}$/.test(commit)) throw new EngineError('DELEGATION_BASE_UNAVAILABLE', 'Delegation requires an existing local Git HEAD commit');
  return commit;
}
