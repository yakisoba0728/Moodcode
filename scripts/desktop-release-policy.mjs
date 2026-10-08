export function releaseRequirements(platform, environment) {
  const missing = [];
  if (platform === 'darwin') {
    if (!environment.CSC_LINK) missing.push('CSC_LINK');
    if (!environment.CSC_KEY_PASSWORD) missing.push('CSC_KEY_PASSWORD');
    const appleId = environment.APPLE_ID && environment.APPLE_APP_SPECIFIC_PASSWORD && environment.APPLE_TEAM_ID;
    const apiKey = environment.APPLE_API_KEY && environment.APPLE_API_KEY_ID && environment.APPLE_API_ISSUER;
    if (!appleId && !apiKey) missing.push('Apple notarization credentials');
  } else if (platform === 'win32') {
    if (!(environment.WIN_CSC_LINK || environment.CSC_LINK)) missing.push('WIN_CSC_LINK or CSC_LINK');
    if (!(environment.WIN_CSC_KEY_PASSWORD || environment.CSC_KEY_PASSWORD)) missing.push('Windows certificate password');
    if (!environment.MOODCODE_WINDOWS_PUBLISHER_NAME) missing.push('MOODCODE_WINDOWS_PUBLISHER_NAME');
  } else if (platform !== 'linux') missing.push('supported release platform');
  return missing;
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value) || value.length > 64) throw new Error('A stable semantic version is required.');
  const result = value.split('.').map(Number);
  if (!result.every(Number.isSafeInteger)) throw new Error('Release version exceeds its bound.');
  return result;
}
export function rollbackReleasePlan({ installedVersion, rollbackVersion, goodCommit }) {
  const old = parseVersion(installedVersion), next = parseVersion(rollbackVersion);
  if (!/^[a-f0-9]{40}$/u.test(goodCommit)) throw new Error('Rollback requires a verified immutable Git commit.');
  const different = next.findIndex((part, index) => part !== old[index]);
  if (different === -1 || next[different] < old[different]) throw new Error('A rollback release must have a version greater than the withdrawn release.');
  return { schemaVersion: 1, channel: 'stable', kind: 'rollback-release', sourceCommit: goodCommit,
    version: rollbackVersion, replacesVersion: installedVersion, publishing: 'disabled',
    steps: ['Build the known good commit in an isolated checkout with the new version.', 'Verify the bundle, utility, SQLite, supervisor, renderer and signed installer on its OS.',
      'Review artifacts and signatures before publishing.', 'Publish the higher version only after human release approval; clients retain downgrade protection.'] };
}
