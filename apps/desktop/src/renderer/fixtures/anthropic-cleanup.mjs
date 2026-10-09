import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function finishAnthropicFixture({ report, closeApplication, diagnostics, heldResponse, server, output }) {
  let diagnosticFailed = false;
  const unknown = () => {
    report.cleanup = { ...report.cleanup, state: 'unknown', nativeConfirmed: null, originalPreserved: true };
  };
  const failed = phase => {
    diagnosticFailed = true;
    report.status = 'failed';
    (report.diagnosticFailures ??= []).push({ phase, code: 'FIXTURE_FINALIZATION_FAILED' });
    unknown();
  };
  try {
    try { await closeApplication(); } catch { failed('application-close'); }
    for (const { phase, collect } of diagnostics) {
      try { await collect(); } catch { failed(phase); }
      if (diagnosticFailed) unknown();
    }
  } finally {
    try { heldResponse?.destroy(); } catch { failed('held-response-close'); }
    try { server.closeAllConnections(); } catch { failed('server-connections-close'); }
    try {
      await new Promise((resolveClosed, reject) => server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolveClosed();
      }));
    } catch { failed('server-close'); }
    try {
      await mkdir(dirname(resolve(output)), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    } catch { failed('report-write'); return { reportWritten: false }; }
  }
  return { reportWritten: true };
}
