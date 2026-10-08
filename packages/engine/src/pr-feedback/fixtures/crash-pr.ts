import { prFixture } from "./pr.js";
import type { TestContext } from "node:test";
const phase = process.argv[2]!;
const f = await prFixture({ after() {} } as unknown as TestContext);
f.engine.store.setSessionPaused(f.session.id, true, "user");
await f.register();
const actual = f.engine.store.acceptInput.bind(f.engine.store);
if (phase === "before-commit")
  f.engine.store.acceptInput = (input) => {
    const r = actual(input);
    void process.send!({
      ready: true,
      phase,
      base: f.base,
      root: f.root,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspace: f.workspace,
      session: f.session,
      sourceRun: f.sourceRun,
      occurrenceId: null,
    });
    process.kill(process.pid, "SIGSTOP");
    return r;
  };
else
  f.engine.scheduler.wake = async () => {
    const watch = f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!;
    void process.send!({
      ready: true,
      phase,
      base: f.base,
      root: f.root,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspace: f.workspace,
      session: f.session,
      sourceRun: f.sourceRun,
      occurrenceId: watch.snapshot,
    });
    process.kill(process.pid, "SIGSTOP");
  };
await f.engine.pollPrWatch(f.pollInput("crash"));
