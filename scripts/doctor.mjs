#!/usr/bin/env node

const HELP = `Moodcode engine doctor

Usage: node scripts/doctor.mjs [options]
  --workspace PATH          Inspect a Git working tree without changing it
  --artifact-parent PATH    Observe existing ancestor permissions; do not create it
  --credential-env NAME     Report environment key presence only; may repeat
  --git PATH                Select a Git executable (default: git)
  --timeout-ms NUMBER       Timeout per Git process, 1..10000 (default: 3000)
  --max-report-bytes NUMBER  Compact JSON budget, 2048..65536 (default: 16384)
  --json                    Print one compact JSON report
  --help                    Print this help

Exit codes: 0 checks passed, 1 findings/unknown checks, 2 configuration/build error,
130 interrupted, 143 terminated. Build the engine before running doctor.
`;

class FlagError extends Error { code = 'INVALID_DOCTOR_FLAGS'; }

function parseFlags(args) {
  if (args.length > 80) throw new FlagError('Too many doctor arguments');
  const options = { credentialEnvNames: [] };
  let json = false;
  let help = false;
  const seen = new Set();
  const values = new Map([
    ['--workspace', 'workspacePath'], ['--artifact-parent', 'artifactParent'], ['--git', 'gitExecutable'],
    ['--timeout-ms', 'timeoutMs'], ['--max-report-bytes', 'maxReportBytes'],
  ]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json' || flag === '--help') {
      if (seen.has(flag)) throw new FlagError('A doctor option was repeated');
      seen.add(flag);
      if (flag === '--json') json = true;
      else help = true;
      continue;
    }
    if (!values.has(flag) && flag !== '--credential-env') throw new FlagError('Unknown doctor option; use --help for supported flags');
    if (flag !== '--credential-env' && seen.has(flag)) throw new FlagError('A doctor option was repeated');
    seen.add(flag);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new FlagError('A doctor option is missing its value');
    if (Buffer.byteLength(value) > 4096 || value.includes('\0')) throw new FlagError('Doctor option value exceeds its input limit');
    if (flag === '--credential-env') { options.credentialEnvNames.push(value); continue; }
    const key = values.get(flag);
    if (key === 'timeoutMs' || key === 'maxReportBytes') {
      if (!/^\d+$/.test(value)) throw new FlagError('Numeric doctor options require a positive integer');
      options[key] = Number(value);
    } else options[key] = value;
  }
  return { options, json, help };
}

function utf8Prefix(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function humanReport(report, maxBytes) {
  // JSON-escape strings so branch names and paths cannot inject terminal control characters.
  const value = input => input === undefined ? '(omitted)' : JSON.stringify(input);
  const lines = [
    `Moodcode engine doctor: ${report.ok ? 'checks passed' : 'attention required'}`,
    `Node: ${value(report.runtime.node.actualVersion)}; requirement ${report.runtime.node.requiredVersion}; minimum ${value(report.runtime.node.meetsMinimum)}`,
    `SQLite: available=${report.sqlite.available}, memory query=${report.sqlite.verified}, version=${value(report.sqlite.version)}`,
    `Git: ${report.git.status}, version=${value(report.git.version)}`,
    `Runtime: ${value(report.runtime.platform)}/${value(report.runtime.architecture)}, Electron=${report.runtime.electron.detected}`,
    `Commands: ${report.runtime.command.code}`,
  ];
  if (report.workspace !== undefined) lines.push(`Workspace: ${report.workspace.status}, root=${value(report.workspace.root)}, branch=${value(report.workspace.branch)}, dirty=${value(report.workspace.dirty)}, status entries=${value(report.workspace.statusEntries)}${report.workspace.code === undefined ? '' : `, code=${report.workspace.code}`}`);
  if (report.artifacts !== undefined) lines.push(`Artifact parent: ${report.artifacts.status}, ancestor=${value(report.artifacts.existingAncestor)}, mode=${value(report.artifacts.mode)}, creation inference=${value(report.artifacts.createPossible)} (no write probe)`);
  for (const check of report.credentials.checks) lines.push(`Credential environment ${value(check.name)}: present=${check.configured} (presence only)`);
  for (const warning of report.warnings) lines.push(`${warning.code}: ${warning.message}`);
  if (report.truncated) lines.push(`Report details omitted: ${report.omittedDetails.join(', ')}`);
  const content = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(content) <= maxBytes) return content;
  const marker = '\n[output truncated]\n';
  return `${utf8Prefix(content, maxBytes - Buffer.byteLength(marker))}${marker}`;
}

const controller = new AbortController();
let termination;
const interrupt = () => { termination = 'SIGINT'; controller.abort(); };
const terminate = () => { termination = 'SIGTERM'; controller.abort(); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);

try {
  const { options, json, help } = parseFlags(process.argv.slice(2));
  if (help) process.stdout.write(HELP);
  else {
    let module;
    try { module = await import('../packages/engine/dist/diagnostics/index.js'); }
    catch { const error = new Error('Compiled diagnostics are unavailable; run npm run build first'); error.code = 'DOCTOR_BUILD_REQUIRED'; throw error; }
    const maxBytes = options.maxReportBytes ?? module.DIAGNOSTICS_LIMITS.defaultReportBytes;
    const report = await module.getDiagnostics({ ...options, maxReportBytes: maxBytes, signal: controller.signal });
    const serialized = JSON.stringify(report);
    process.stdout.write(json ? serialized + (Buffer.byteLength(serialized) < maxBytes ? '\n' : '') : humanReport(report, maxBytes));
    process.exitCode = report.ok ? 0 : 1;
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'DOCTOR_FAILED';
  const known = ['INVALID_DOCTOR_FLAGS', 'INVALID_DIAGNOSTICS_OPTIONS', 'DOCTOR_BUILD_REQUIRED', 'ABORTED', 'DIAGNOSTICS_REPORT_LIMIT'];
  const message = known.includes(code) ? error.message : 'Doctor could not complete its environment checks';
  if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = termination === 'SIGINT' ? 130 : termination === 'SIGTERM' ? 143 : 2;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
