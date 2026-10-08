# Windows command ownership binding

`@moodcode/windows-job` is a private, raw Node-API 8 addon. It requires Windows 10 / Windows Server 2016 or newer and an x64 or arm64 runtime. The dedicated native acceptance workflow targets Windows Server 2025 x64 with Node 24 and 26. Installing/importing this workspace is portable; creating a job on another platform, or without its compiled binary, throws `WINDOWS_JOB_BACKEND_UNAVAILABLE`.

## Build and desktop interface

From the repository root, run `npm ci`, then `npm run prepare:windows-job` on Windows with Visual Studio C++ build tools, a Windows SDK, Python, and the repository's pinned `node-gyp`. The package's install script intentionally performs no compilation. `node packages/windows-job/scripts/build.mjs` invokes `node-gyp` with the current Node target and architecture and writes `packages/windows-job/build/Release/windows_job.node`.

For an Electron build, use its exact target and architecture:

```powershell
node packages/windows-job/scripts/build.mjs --runtime=electron --target=<electron-version> --arch=x64
```

The build retains `win_delay_load_hook`; the addon uses no V8 or Node C++ ABI and no third-party native libraries. Node-API 8 is the ABI boundary. Buffers use `napi_create_buffer_copy`, so Electron configurations that disallow external buffers are supported by the source. Desktop packaging must retain the package loader and binary at the relative `build/Release/windows_job.node` location, unpack `.node` files from ASAR, and verify `nativeInfo()` plus actual command/tree cleanup in its target runtime. A Node workflow pass does not verify an Electron bundle, installer, signing, update, arm64 execution, or ABI behavior in a packaged app.

## Resource contract

`createJob()` returns one unnamed Job Object handle owned by the engine process, with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The handle is non-inheritable; only the child's NUL stdin and stdout/stderr writer handles appear in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.

`job.spawnSuspended({ command, cwd, environment })` executes the explicit system-directory `cmd.exe /d /s /c` interpreter, with `CREATE_SUSPENDED` and a sorted, case-insensitive unique Unicode environment. It also installs `PROC_THREAD_ATTRIBUTE_JOB_LIST`: Job Object membership is established atomically by `CreateProcessW`, including the gap before the JS caller can invoke `assign`. `job.assign(child)` verifies actual membership using `IsProcessInJob` (and assigns if membership is absent). Only then does `job.resume(child)` resume its primary thread. Resume before assign, repeated resume, borrowed receivers, and foreign-job children fail with `WINDOWS_JOB_INVALID_STATE`.

`job.activeProcessCount()` reads `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses` through `QueryInformationJobObject` on every call. It never counts cached PIDs. `job.terminate()` terminates the owned tree. `job.close()` is idempotent and closes the owner job handle, killing every owned process; subsequent job queries/launches fail. Neither breakaway flag is enabled. The job provides process ownership under the host user, without file or network isolation.

`child.readOutput(maxBytes = 65536)` returns copied stdout/stderr buffers, independent EOF flags, and primary exit status. Reads are nonblocking and bounded per stream; `readOutput(0)` polls without consuming queued bytes. Exit is observed with a signaled process handle before `GetExitCodeProcess`, so a legitimate exit code 259 is preserved. The observed exit code persists in native state; process/thread handles are released immediately while output readers remain open. This is required because `ActiveProcesses` decrements only after a terminated process exits and all its references are released. Waiting for output EOF before releasing the primary handle would misclassify a normally exited command with queued output as a retained descendant. Primary exit alone does not establish descendant exit or output EOF. A host must observe exit, terminate retained descendants, drain output, wait for job count zero, and close the child.

`child.close()` is idempotent, terminates a running primary and releases its thread/process/reader handles; unread bytes are discarded. `job.close()` leaves child handles readable for final exit/output observation until `child.close()`. Native finalizers close the owner handle and release child handles. An environment cleanup hook releases all resources on normal Node/worker teardown; abrupt engine termination closes OS handles and activates kill-on-close. There is no helper process retaining the job handle.

Native Win32 errors have generic messages, `code = WINDOWS_JOB_NATIVE_ERROR`, and a numeric `win32Code`. Inputs/environment contents never appear in native error messages. `nativeInfo()` exposes binding version, Node-API version, platform, architecture, and atomic assignment; the loader validates them before use. `currentProcessHandleCount()` calls `GetProcessHandleCount` for real repeated-close/leak verification.

## Official references

- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Creation attributes: inherited handles and atomic job list](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- [Job Object basic accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
- [PeekNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-peeknamedpipe)
- [Node-API ABI and copied buffers](https://nodejs.org/api/n-api.html)
- [Electron native modules and Windows delay-load hook](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [node-gyp third-party runtime builds](https://github.com/nodejs/node-gyp#building-for-third-party-nodejs-runtimes)
