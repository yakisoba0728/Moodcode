#include <node_api.h>
#include <windows.h>

#include <algorithm>
#include <array>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr DWORD kTerminationCode = 1;
constexpr uint32_t kReadLimit = 65536;
constexpr napi_type_tag kJobTag = {0xaef67a9956c14848ULL, 0x89275325fc2d8e43ULL};
constexpr napi_type_tag kChildTag = {0xaef67a9956c14848ULL, 0xaba734a989f725a1ULL};

struct NativeError : std::runtime_error {
  DWORD win32_code;
  const char* code;
  NativeError(const char* message, DWORD win32 = 0,
              const char* category = "WINDOWS_JOB_NATIVE_ERROR")
      : std::runtime_error(message), win32_code(win32), code(category) {}
};

void Check(BOOL success, const char* operation) {
  if (!success) throw NativeError(operation, GetLastError());
}

void Napi(napi_status status) {
  if (status != napi_ok) throw NativeError("The native JavaScript interface failed.");
}

[[noreturn]] void Invalid(const char* message) {
  throw NativeError(message, 0, "WINDOWS_JOB_INVALID_STATE");
}

class Handle {
 public:
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.Release()) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { Reset(); value = other.Release(); }
    return *this;
  }
  ~Handle() { Reset(); }
  HANDLE Release() noexcept { HANDLE handle = value; value = nullptr; return handle; }
  void Reset() noexcept {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    value = nullptr;
  }
  void Close() {
    if (!value) return;
    Check(CloseHandle(value), "Closing a native ownership handle failed.");
    value = nullptr;
  }
};

struct ChildState;
struct JobState {
  Handle handle;
  std::vector<std::weak_ptr<ChildState>> children;
  explicit JobState(HANDLE job) : handle(job) {}
  void RequireOpen() const {
    if (!handle.value) Invalid("The native job is closed.");
  }
};

struct ChildState {
  std::shared_ptr<JobState> owner;
  Handle process;
  Handle thread;
  Handle stdout_read;
  Handle stderr_read;
  DWORD pid = 0;
  bool assigned = false;
  bool resumed = false;
  bool closed = false;
  bool exited = false;
  DWORD exit_code = 0;

  void RequireOpen() const {
    if (closed || (!process.value && !exited)) Invalid("The native process is closed.");
  }
  void ObserveExit() {
    if (exited) return;
    DWORD wait = WaitForSingleObject(process.value, 0);
    if (wait == WAIT_FAILED) throw NativeError("Observing native process exit failed.", GetLastError());
    if (wait == WAIT_OBJECT_0) {
      Check(GetExitCodeProcess(process.value, &exit_code), "Reading native process exit failed.");
      exited = true;
      // Job accounting retains exited processes until their references close.
      // Pipe readers remain independent so status polling never discards output.
      thread.Close();
      process.Close();
    }
  }
  void Terminate() {
    RequireOpen();
    ObserveExit();
    if (exited) return;
    if (!TerminateProcess(process.value, kTerminationCode)) {
      DWORD error = GetLastError();
      ObserveExit();
      if (!exited) throw NativeError("Terminating the native primary process failed.", error);
    }
  }
  void Close() {
    if (closed) return;
    Terminate();
    thread.Close();
    stdout_read.Close();
    stderr_read.Close();
    process.Close();
    closed = true;
  }
  ~ChildState() {
    if (!closed && process.value) {
      // Finalizers and environment teardown perform no JavaScript operations.
      TerminateProcess(process.value, kTerminationCode);
    }
  }
};

struct EnvironmentState {
  std::vector<std::weak_ptr<JobState>> jobs;
};

template <typename State>
struct Wrapped { std::shared_ptr<State> state; };

void CleanupEnvironment(void* data) {
  std::unique_ptr<EnvironmentState> environment(static_cast<EnvironmentState*>(data));
  for (const auto& weak_job : environment->jobs) {
    auto job = weak_job.lock();
    if (!job) continue;
    job->handle.Reset();
    for (const auto& weak_child : job->children) {
      if (auto child = weak_child.lock()) {
        if (!child->closed && child->process.value) TerminateProcess(child->process.value, kTerminationCode);
        child->thread.Reset();
        child->stdout_read.Reset();
        child->stderr_read.Reset();
        child->process.Reset();
        child->closed = true;
      }
    }
  }
}

void FinalizeJob(napi_env, void* data, void*) {
  std::unique_ptr<Wrapped<JobState>> wrapped(static_cast<Wrapped<JobState>*>(data));
  wrapped->state->handle.Reset();
}

void FinalizeChild(napi_env, void* data, void*) {
  delete static_cast<Wrapped<ChildState>*>(data);
}

template <typename State>
std::shared_ptr<State> Unwrap(napi_env env, napi_value object, const napi_type_tag& tag) {
  napi_valuetype type;
  Napi(napi_typeof(env, object, &type));
  napi_value null_value;
  Napi(napi_get_null(env, &null_value));
  bool is_null = false;
  Napi(napi_strict_equals(env, object, null_value, &is_null));
  if (type != napi_object || is_null) Invalid("The native ownership identity is invalid.");
  bool matches = false;
  Napi(napi_check_object_type_tag(env, object, &tag, &matches));
  if (!matches) Invalid("The native ownership identity is invalid.");
  void* data = nullptr;
  Napi(napi_unwrap(env, object, &data));
  if (!data) Invalid("The native ownership identity is unavailable.");
  return static_cast<Wrapped<State>*>(data)->state;
}

struct Arguments {
  napi_value receiver;
  napi_value values[1] = {};
  size_t count = 1;
  void* data = nullptr;
  Arguments(napi_env env, napi_callback_info info) {
    Napi(napi_get_cb_info(env, info, &count, values, &receiver, &data));
  }
};

template <typename Operation>
napi_value Invoke(napi_env env, Operation operation) {
  auto raise = [&](const char* message_text, const char* code_text, DWORD win32_code) -> napi_value {
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) return nullptr;
    napi_value message = nullptr, code = nullptr, thrown = nullptr;
    if (napi_create_string_utf8(env, message_text, NAPI_AUTO_LENGTH, &message) != napi_ok ||
        napi_create_string_utf8(env, code_text, NAPI_AUTO_LENGTH, &code) != napi_ok ||
        napi_create_error(env, code, message, &thrown) != napi_ok) return nullptr;
    if (win32_code) {
      napi_value win32 = nullptr;
      if (napi_create_uint32(env, win32_code, &win32) != napi_ok ||
          napi_set_named_property(env, thrown, "win32Code", win32) != napi_ok) return nullptr;
    }
    napi_throw(env, thrown);
    return nullptr;
  };
  try { return operation(); }
  catch (const NativeError& error) { return raise(error.what(), error.code, error.win32_code); }
  catch (...) { return raise("The native Windows operation failed.", "WINDOWS_JOB_NATIVE_ERROR", 0); }
}

napi_value Undefined(napi_env env) { napi_value result; Napi(napi_get_undefined(env, &result)); return result; }
napi_value Boolean(napi_env env, bool value) { napi_value result; Napi(napi_get_boolean(env, value, &result)); return result; }
napi_value Number(napi_env env, uint32_t value) { napi_value result; Napi(napi_create_uint32(env, value, &result)); return result; }
napi_value String(napi_env env, const char* value) {
  napi_value result; Napi(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result)); return result;
}
void Property(napi_env env, napi_value object, const char* name, napi_value value) {
  Napi(napi_set_named_property(env, object, name, value));
}
napi_value GetProperty(napi_env env, napi_value object, const char* name) {
  napi_value value; Napi(napi_get_named_property(env, object, name, &value)); return value;
}

std::wstring ReadString(napi_env env, napi_value value) {
  napi_valuetype type;
  Napi(napi_typeof(env, value, &type));
  if (type != napi_string) Invalid("Native spawn arguments must be strings.");
  size_t size = 0;
  Napi(napi_get_value_string_utf16(env, value, nullptr, 0, &size));
  std::vector<char16_t> buffer(size + 1);
  Napi(napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &size));
  std::wstring result(buffer.begin(), buffer.begin() + size);
  if (result.find(L'\0') != std::wstring::npos) Invalid("Native spawn arguments cannot contain NUL.");
  return result;
}

void RequireObject(napi_env env, napi_value value) {
  napi_valuetype type;
  Napi(napi_typeof(env, value, &type));
  napi_value null_value;
  Napi(napi_get_null(env, &null_value));
  bool is_null;
  Napi(napi_strict_equals(env, value, null_value, &is_null));
  bool array;
  Napi(napi_is_array(env, value, &array));
  if (type != napi_object || is_null || array) Invalid("Native spawn input must be an object.");
}

int CompareName(const std::wstring& left, const std::wstring& right) {
  int comparison = CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()),
                                        right.c_str(), static_cast<int>(right.size()), TRUE);
  if (!comparison) throw NativeError("Comparing native environment names failed.", GetLastError());
  return comparison;
}

std::vector<wchar_t> ReadEnvironment(napi_env env, napi_value environment) {
  RequireObject(env, environment);
  napi_value keys;
  Napi(napi_get_all_property_names(env, environment, napi_key_own_only,
      static_cast<napi_key_filter>(napi_key_enumerable | napi_key_skip_symbols),
      napi_key_numbers_to_strings, &keys));
  uint32_t count;
  Napi(napi_get_array_length(env, keys, &count));
  std::vector<std::pair<std::wstring, std::wstring>> entries;
  entries.reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    napi_value key, value;
    Napi(napi_get_element(env, keys, index, &key));
    Napi(napi_get_property(env, environment, key, &value));
    std::wstring name = ReadString(env, key);
    const bool drive = name.size() == 3 && name[0] == L'=' && name[2] == L':' &&
        ((name[1] >= L'A' && name[1] <= L'Z') || (name[1] >= L'a' && name[1] <= L'z'));
    if (name.empty() || (!drive && name.find(L'=') != std::wstring::npos)) Invalid("Native environment names are invalid.");
    entries.emplace_back(std::move(name), ReadString(env, value));
  }
  std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
    return CompareName(left.first, right.first) == CSTR_LESS_THAN;
  });
  std::vector<wchar_t> block;
  for (size_t index = 0; index < entries.size(); ++index) {
    if (index && CompareName(entries[index - 1].first, entries[index].first) == CSTR_EQUAL)
      Invalid("Native environment names must be unique without regard to case.");
    const auto& entry = entries[index];
    block.insert(block.end(), entry.first.begin(), entry.first.end());
    block.push_back(L'=');
    block.insert(block.end(), entry.second.begin(), entry.second.end());
    block.push_back(L'\0');
  }
  // Even an empty Unicode environment is a double-NUL terminated block.
  block.push_back(L'\0');
  if (entries.empty()) block.push_back(L'\0');
  return block;
}

struct Pipe { Handle read; Handle write; };
Pipe OutputPipe() {
  SECURITY_ATTRIBUTES security = {sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE read = nullptr, write = nullptr;
  Check(CreatePipe(&read, &write, &security, 65536), "Creating native output pipes failed.");
  Pipe result{Handle(read), Handle(write)};
  Check(SetHandleInformation(result.read.value, HANDLE_FLAG_INHERIT, 0), "Protecting the native output reader failed.");
  return result;
}

class Attributes {
 public:
  std::vector<unsigned char> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  Attributes() {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
    if (!size) throw NativeError("Sizing native process attributes failed.", GetLastError());
    storage.resize(size);
    value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(value, 2, 0, &size)) {
      value = nullptr;
      throw NativeError("Creating native process attributes failed.", GetLastError());
    }
  }
  ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
  Attributes(const Attributes&) = delete;
  Attributes& operator=(const Attributes&) = delete;
};

std::vector<char> ReadPipe(Handle& pipe, uint32_t maximum) {
  if (!pipe.value) return {};
  DWORD available = 0;
  auto peek = [&]() {
    if (PeekNamedPipe(pipe.value, nullptr, 0, nullptr, &available, nullptr)) return true;
    DWORD error = GetLastError();
    if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) { pipe.Close(); return false; }
    throw NativeError("Polling native output failed.", error);
  };
  if (!peek() || !maximum || !available) return {};
  DWORD size = std::min<DWORD>(available, maximum);
  std::vector<char> bytes(size);
  DWORD read = 0;
  if (!ReadFile(pipe.value, bytes.data(), size, &read, nullptr)) {
    DWORD error = GetLastError();
    if (error != ERROR_BROKEN_PIPE && error != ERROR_PIPE_NOT_CONNECTED) throw NativeError("Reading native output failed.", error);
    pipe.Close();
  }
  bytes.resize(read);
  if (pipe.value) peek();
  return bytes;
}

napi_value ChildReadOutput(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    Arguments arguments(env, info);
    auto child = Unwrap<ChildState>(env, arguments.receiver, kChildTag);
    child->RequireOpen();
    uint32_t maximum = kReadLimit;
    if (arguments.count) {
      napi_valuetype type;
      Napi(napi_typeof(env, arguments.values[0], &type));
      if (type != napi_number) Invalid("Native output reads must request a number.");
      double requested;
      Napi(napi_get_value_double(env, arguments.values[0], &requested));
      if (!(requested >= 0 && requested <= kReadLimit) || requested != static_cast<uint32_t>(requested))
        Invalid("Native output reads must request an integer from zero through 65536.");
      maximum = static_cast<uint32_t>(requested);
    }
    auto stdout_bytes = ReadPipe(child->stdout_read, maximum);
    auto stderr_bytes = ReadPipe(child->stderr_read, maximum);
    child->ObserveExit();
    napi_value result, stdout_buffer, stderr_buffer, exit_code;
    Napi(napi_create_object(env, &result));
    // Copying buffers supports Electron configurations that forbid external buffers.
    Napi(napi_create_buffer_copy(env, stdout_bytes.size(), stdout_bytes.empty() ? "" : stdout_bytes.data(), nullptr, &stdout_buffer));
    Napi(napi_create_buffer_copy(env, stderr_bytes.size(), stderr_bytes.empty() ? "" : stderr_bytes.data(), nullptr, &stderr_buffer));
    Property(env, result, "stdout", stdout_buffer);
    Property(env, result, "stderr", stderr_buffer);
    Property(env, result, "stdoutClosed", Boolean(env, !child->stdout_read.value));
    Property(env, result, "stderrClosed", Boolean(env, !child->stderr_read.value));
    Property(env, result, "exited", Boolean(env, child->exited));
    if (child->exited) exit_code = Number(env, child->exit_code);
    else Napi(napi_get_null(env, &exit_code));
    Property(env, result, "exitCode", exit_code);
    return result;
  });
}

napi_value ChildTerminate(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] { Arguments arguments(env, info); Unwrap<ChildState>(env, arguments.receiver, kChildTag)->Terminate(); return Undefined(env); });
}
napi_value ChildClose(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] { Arguments arguments(env, info); Unwrap<ChildState>(env, arguments.receiver, kChildTag)->Close(); return Undefined(env); });
}

napi_value WrapChild(napi_env env, std::shared_ptr<ChildState> child) {
  napi_value object;
  Napi(napi_create_object(env, &object));
  napi_property_descriptor properties[] = {
    {"pid", nullptr, nullptr, nullptr, nullptr, Number(env, child->pid), napi_enumerable, nullptr},
    {"readOutput", nullptr, ChildReadOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminate", nullptr, ChildTerminate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, ChildClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  Napi(napi_define_properties(env, object, std::size(properties), properties));
  Napi(napi_type_tag_object(env, object, &kChildTag));
  auto wrapped = std::make_unique<Wrapped<ChildState>>(Wrapped<ChildState>{std::move(child)});
  Napi(napi_wrap(env, object, wrapped.get(), FinalizeChild, nullptr, nullptr));
  wrapped.release();
  return object;
}

napi_value JobSpawnSuspended(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    Arguments arguments(env, info);
    auto job = Unwrap<JobState>(env, arguments.receiver, kJobTag);
    job->RequireOpen();
    if (!arguments.count) Invalid("Native process spawn input is required.");
    RequireObject(env, arguments.values[0]);
    auto command = ReadString(env, GetProperty(env, arguments.values[0], "command"));
    auto cwd = ReadString(env, GetProperty(env, arguments.values[0], "cwd"));
    auto environment = ReadEnvironment(env, GetProperty(env, arguments.values[0], "environment"));
    job->RequireOpen();
    if (command.empty() || cwd.empty()) Invalid("Native command and working directory must be nonempty.");
    std::array<wchar_t, MAX_PATH + 1> system_directory{};
    UINT size = GetSystemDirectoryW(system_directory.data(), static_cast<UINT>(system_directory.size()));
    if (!size || size >= system_directory.size()) throw NativeError("Locating the Windows command interpreter failed.", GetLastError());
    std::wstring executable(system_directory.data(), size);
    executable += L"\\cmd.exe";
    std::wstring command_line = L"\"" + executable + L"\" /d /s /c \"" + command + L"\"";
    if (command_line.size() >= 32767) Invalid("The native Windows command exceeds the command-line limit.");
    std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
    mutable_command.push_back(L'\0');
    auto stdout_pipe = OutputPipe();
    auto stderr_pipe = OutputPipe();
    SECURITY_ATTRIBUTES security = {sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle stdin_handle(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (stdin_handle.value == INVALID_HANDLE_VALUE) throw NativeError("Creating native standard input failed.", GetLastError());
    Attributes attributes;
    HANDLE inherited[] = {stdin_handle.value, stdout_pipe.write.value, stderr_pipe.write.value};
    Check(UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof(inherited), nullptr, nullptr), "Restricting inherited native handles failed.");
    HANDLE owner = job->handle.value;
    // Atomic assignment closes the engine-crash gap before the explicit assign stage.
    // The job handle is absent from HANDLE_LIST and itself non-inheritable.
    Check(UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        &owner, sizeof(owner), nullptr, nullptr), "Installing atomic native job ownership failed.");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_handle.value;
    startup.StartupInfo.hStdOutput = stdout_pipe.write.value;
    startup.StartupInfo.hStdError = stderr_pipe.write.value;
    startup.lpAttributeList = attributes.value;
    auto child = std::make_shared<ChildState>();
    child->owner = job;
    PROCESS_INFORMATION process{};
    Check(CreateProcessW(executable.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
        environment.data(), cwd.c_str(), &startup.StartupInfo, &process), "Creating the suspended owned Windows process failed.");
    child->process = Handle(process.hProcess);
    child->thread = Handle(process.hThread);
    child->pid = process.dwProcessId;
    child->stdout_read = std::move(stdout_pipe.read);
    child->stderr_read = std::move(stderr_pipe.read);
    job->children.erase(std::remove_if(job->children.begin(), job->children.end(),
        [](const auto& weak) { return weak.expired(); }), job->children.end());
    job->children.push_back(child);
    return WrapChild(env, std::move(child));
  });
}

std::shared_ptr<ChildState> OwnedChild(napi_env env, const Arguments& arguments, const std::shared_ptr<JobState>& job) {
  job->RequireOpen();
  if (!arguments.count) Invalid("A native owned process is required.");
  auto child = Unwrap<ChildState>(env, arguments.values[0], kChildTag);
  child->RequireOpen();
  if (child->exited || !child->process.value) Invalid("The native process has already exited.");
  if (child->owner.get() != job.get()) Invalid("The native process belongs to a different job.");
  return child;
}

napi_value JobAssign(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    Arguments arguments(env, info);
    auto job = Unwrap<JobState>(env, arguments.receiver, kJobTag);
    auto child = OwnedChild(env, arguments, job);
    if (child->resumed) Invalid("A native running process cannot be assigned again.");
    BOOL member = FALSE;
    Check(IsProcessInJob(child->process.value, job->handle.value, &member), "Verifying native job membership failed.");
    if (!member) {
      Check(AssignProcessToJobObject(job->handle.value, child->process.value), "Assigning native job ownership failed.");
      Check(IsProcessInJob(child->process.value, job->handle.value, &member), "Rechecking native job membership failed.");
      if (!member) Invalid("The native process has no confirmed job ownership.");
    }
    child->assigned = true;
    return Undefined(env);
  });
}

napi_value JobResume(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    Arguments arguments(env, info);
    auto job = Unwrap<JobState>(env, arguments.receiver, kJobTag);
    auto child = OwnedChild(env, arguments, job);
    if (!child->assigned || child->resumed || !child->thread.value) Invalid("Native resume requires assigned suspended ownership.");
    DWORD previous = ResumeThread(child->thread.value);
    if (previous == static_cast<DWORD>(-1)) throw NativeError("Resuming the native owned process failed.", GetLastError());
    if (previous != 1) Invalid("The native primary thread had an unexpected suspend count.");
    child->resumed = true;
    child->thread.Close();
    return Undefined(env);
  });
}

napi_value JobTerminate(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    Arguments arguments(env, info);
    auto job = Unwrap<JobState>(env, arguments.receiver, kJobTag);
    job->RequireOpen();
    Check(TerminateJobObject(job->handle.value, kTerminationCode), "Terminating the native owned process tree failed.");
    return Undefined(env);
  });
}

napi_value JobActiveProcessCount(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    Arguments arguments(env, info);
    auto job = Unwrap<JobState>(env, arguments.receiver, kJobTag);
    job->RequireOpen();
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    Check(QueryInformationJobObject(job->handle.value, JobObjectBasicAccountingInformation,
        &accounting, sizeof(accounting), nullptr), "Querying native job process accounting failed.");
    return Number(env, accounting.ActiveProcesses);
  });
}

napi_value JobClose(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] { Arguments arguments(env, info); Unwrap<JobState>(env, arguments.receiver, kJobTag)->handle.Close(); return Undefined(env); });
}

napi_value CreateJob(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    Arguments arguments(env, info);
    auto* environment = static_cast<EnvironmentState*>(arguments.data);
    Handle handle(CreateJobObjectW(nullptr, nullptr));
    if (!handle.value) throw NativeError("Creating the native Job Object failed.", GetLastError());
    Check(SetHandleInformation(handle.value, HANDLE_FLAG_INHERIT, 0), "Protecting native job ownership failed.");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Check(SetInformationJobObject(handle.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)),
        "Installing kill-on-close native ownership failed.");
    auto job = std::make_shared<JobState>(handle.value);
    handle.Release();
    napi_value object;
    Napi(napi_create_object(env, &object));
    napi_property_descriptor properties[] = {
      {"spawnSuspended", nullptr, JobSpawnSuspended, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assign", nullptr, JobAssign, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resume", nullptr, JobResume, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminate", nullptr, JobTerminate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"activeProcessCount", nullptr, JobActiveProcessCount, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, JobClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Napi(napi_define_properties(env, object, std::size(properties), properties));
    Napi(napi_type_tag_object(env, object, &kJobTag));
    environment->jobs.erase(std::remove_if(environment->jobs.begin(), environment->jobs.end(),
        [](const auto& weak) { return weak.expired(); }), environment->jobs.end());
    environment->jobs.push_back(job);
    auto wrapped = std::make_unique<Wrapped<JobState>>(Wrapped<JobState>{std::move(job)});
    Napi(napi_wrap(env, object, wrapped.get(), FinalizeJob, nullptr, nullptr));
    wrapped.release();
    return object;
  });
}

napi_value NativeInfo(napi_env env, napi_callback_info) {
  return Invoke(env, [&] {
    napi_value info;
    Napi(napi_create_object(env, &info));
    Property(env, info, "bindingVersion", Number(env, 1));
    Property(env, info, "napiVersion", Number(env, 8));
    Property(env, info, "platform", String(env, "win32"));
#if defined(_M_X64)
    Property(env, info, "arch", String(env, "x64"));
#elif defined(_M_ARM64)
    Property(env, info, "arch", String(env, "arm64"));
#else
    Property(env, info, "arch", String(env, "unsupported"));
#endif
    Property(env, info, "atomicJobAssignment", Boolean(env, true));
    return info;
  });
}

napi_value CurrentProcessHandleCount(napi_env env, napi_callback_info) {
  return Invoke(env, [&] {
    DWORD count = 0;
    Check(GetProcessHandleCount(GetCurrentProcess(), &count), "Querying the native owner handle count failed.");
    return Number(env, count);
  });
}

napi_value Initialize(napi_env env, napi_value exports) {
  return Invoke(env, [&] {
    auto environment = std::make_unique<EnvironmentState>();
    napi_property_descriptor properties[] = {
      {"createJob", nullptr, CreateJob, nullptr, nullptr, nullptr, napi_default, environment.get()},
      {"nativeInfo", nullptr, NativeInfo, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"currentProcessHandleCount", nullptr, CurrentProcessHandleCount, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Napi(napi_define_properties(env, exports, std::size(properties), properties));
    Napi(napi_add_env_cleanup_hook(env, CleanupEnvironment, environment.get()));
    environment.release();
    return exports;
  });
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
