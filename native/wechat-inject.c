/*
 * wechat-inject.c -- minimal, dependency-free (no third-party library) DLL
 * injector for Windows.
 *
 * Usage:
 *   wechat-inject.exe --process WeChat.exe --dll C:\path\sdk.dll [--timeout 15000] [--json]
 *   wechat-inject.exe --pid 1234 --dll C:\path\sdk.dll [--timeout 15000] [--json]
 *
 * Flow: locate the process -> enable SeDebugPrivilege (best effort) -> check
 * that the target architecture matches this injector -> VirtualAllocEx +
 * WriteProcessMemory the wide DLL path -> CreateRemoteThread(LoadLibraryW) ->
 * WaitForSingleObject -> GetExitCodeThread.
 *
 * Build (x64):
 *   gcc -O2 -Wall -Wextra -static -o build\wechat-inject.exe wechat-inject.c -lshell32
 *
 * Exit codes:
 *   0 success | 1 bad usage | 2 process not found | 3 open process failed
 *   4 architecture mismatch | 5 injection failed (alloc/write/thread/timeout)
 */

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* ------------------------------------------------------------------ defines */

#define EXIT_OK                0
#define EXIT_USAGE             1
#define EXIT_PROCESS_NOT_FOUND 2
#define EXIT_OPEN_FAILED       3
#define EXIT_ARCH_MISMATCH     4
#define EXIT_INJECT_FAILED     5

#define DEFAULT_TIMEOUT_MS 15000

/* Architecture this binary was built for (gcc targets one machine at a time). */
#if defined(_WIN64)
#  define INJECTOR_MACHINE IMAGE_FILE_MACHINE_AMD64
#else
#  define INJECTOR_MACHINE IMAGE_FILE_MACHINE_I386
#endif

#ifndef IMAGE_FILE_MACHINE_UNKNOWN
#  define IMAGE_FILE_MACHINE_UNKNOWN 0
#endif
#ifndef IMAGE_FILE_MACHINE_ARM
#  define IMAGE_FILE_MACHINE_ARM 0x01C0
#endif
#ifndef IMAGE_FILE_MACHINE_ARMNT
#  define IMAGE_FILE_MACHINE_ARMNT 0x01C4
#endif
#ifndef IMAGE_FILE_MACHINE_ARM64
#  define IMAGE_FILE_MACHINE_ARM64 0xAA64
#endif

#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

typedef struct {
    const wchar_t *processName; /* --process <image name> */
    const wchar_t *dllPath;     /* --dll <path> */
    DWORD          pid;         /* --pid <n>, 0 = not supplied */
    DWORD          timeoutMs;   /* --timeout <ms> */
    BOOL           json;        /* --json */
} Options;

/* ------------------------------------------------------------------ helpers */

/* Bounded wide-string copy that always NUL terminates (no CRT warnings). */
static void copy_w(wchar_t *dst, size_t cch, const wchar_t *src)
{
    size_t i = 0;

    if (cch == 0) {
        return;
    }
    while (i + 1 < cch && src[i] != L'\0') {
        dst[i] = src[i];
        ++i;
    }
    dst[i] = L'\0';
}

/* Wide -> UTF-8 allocation (caller frees). */
static char *dup_utf8(const wchar_t *s)
{
    int    need;
    char  *out;

    if (s == NULL) {
        return NULL;
    }
    need = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
    if (need <= 0) {
        return NULL;
    }
    out = (char *)malloc((size_t)need);
    if (out == NULL) {
        return NULL;
    }
    if (WideCharToMultiByte(CP_UTF8, 0, s, -1, out, need, NULL, NULL) <= 0) {
        free(out);
        return NULL;
    }
    return out;
}

static void print_w(FILE *f, const wchar_t *s)
{
    char *u = dup_utf8(s);

    if (u != NULL) {
        fputs(u, f);
        free(u);
    }
}

/* Escape one UTF-8 string straight into stdout as a JSON string literal. */
static void json_write_string(const char *s)
{
    const unsigned char *p = (const unsigned char *)s;

    putchar('"');
    for (; *p != '\0'; ++p) {
        unsigned char c = *p;

        switch (c) {
        case '"':  fputs("\\\"", stdout); break;
        case '\\': fputs("\\\\", stdout); break;
        case '\b': fputs("\\b", stdout);  break;
        case '\f': fputs("\\f", stdout);  break;
        case '\n': fputs("\\n", stdout);  break;
        case '\r': fputs("\\r", stdout);  break;
        case '\t': fputs("\\t", stdout);  break;
        default:
            if (c < 0x20) {
                printf("\\u%04x", (unsigned int)c);
            } else {
                putchar((int)c);
            }
            break;
        }
    }
    putchar('"');
}

/* --json failure: exactly one JSON line on stdout, nothing else. */
static void emit_json_fail(const char *code, const wchar_t *message, DWORD pid)
{
    char *msg = dup_utf8(message != NULL ? message : L"");

    printf("{\"ok\":false,\"code\":\"%s\",\"message\":", code);
    json_write_string(msg != NULL ? msg : "");
    printf(",\"pid\":%lu}\n", (unsigned long)pid);
    fflush(stdout);
    free(msg);
}

/* --json success: one JSON line, no other stdout output. */
static void emit_json_ok(DWORD pid, const wchar_t *process, const wchar_t *dll,
                         const wchar_t *injector, const wchar_t *target)
{
    char *pv = dup_utf8(process != NULL ? process : L"");
    char *dv = dup_utf8(dll != NULL ? dll : L"");
    char *iv = dup_utf8(injector != NULL ? injector : L"");
    char *tv = dup_utf8(target != NULL ? target : L"");

    printf("{\"ok\":true,\"pid\":%lu,\"process\":", (unsigned long)pid);
    json_write_string(pv != NULL ? pv : "");
    fputs(",\"dll\":", stdout);
    json_write_string(dv != NULL ? dv : "");
    fputs(",\"injector\":", stdout);
    json_write_string(iv != NULL ? iv : "");
    fputs(",\"target\":", stdout);
    json_write_string(tv != NULL ? tv : "");
    fputs("}\n", stdout);
    fflush(stdout);
    free(pv);
    free(dv);
    free(iv);
    free(tv);
}

/* "what: <system text> (GetLastError()=<n>)" */
static void win_error_msg(wchar_t *buf, size_t cch, const wchar_t *what, DWORD err)
{
    wchar_t sys[512];
    DWORD   n = 0;

    sys[0] = L'\0';
    n = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS |
                           FORMAT_MESSAGE_MAX_WIDTH_MASK,
                       NULL, err, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
                       sys, (DWORD)ARRAY_LEN(sys), NULL);
    if (n == 0) {
        copy_w(sys, ARRAY_LEN(sys), L"<no system message>");
        n = (DWORD)wcslen(sys);
    }
    while (n > 0 && (sys[n - 1] == L'\r' || sys[n - 1] == L'\n' ||
                     sys[n - 1] == L' ' || sys[n - 1] == L'\t')) {
        sys[--n] = L'\0';
    }
    _snwprintf(buf, cch, L"%ls: %ls (GetLastError()=%lu)", what, sys, (unsigned long)err);
    buf[cch - 1] = L'\0';
}

/* Common failure path: pick JSON or human output, return the exit code. */
static int fail_with(const Options *opt, const char *code, int exitCode,
                     const wchar_t *msg, DWORD pid)
{
    if (opt->json) {
        emit_json_fail(code, msg, pid);
    } else {
        fputs("error [", stderr);
        fputs(code, stderr);
        fputs("]: ", stderr);
        print_w(stderr, msg);
        fputc('\n', stderr);
        fflush(stderr);
    }
    return exitCode;
}

/* --------------------------------------------------------- process lookup */

/* "WeChat.exe" == "wechat.exe"; "WeChat" also matches "WeChat.exe". */
static BOOL exe_name_matches(const wchar_t *query, const wchar_t *exeFile)
{
    if (_wcsicmp(query, exeFile) == 0) {
        return TRUE;
    }
    if (wcschr(query, L'.') == NULL) {
        size_t n = wcslen(query);

        if (wcslen(exeFile) > n && _wcsnicmp(query, exeFile, n) == 0 &&
            _wcsicmp(exeFile + n, L".exe") == 0) {
            return TRUE;
        }
    }
    return FALSE;
}

/* First snapshot entry whose image name matches; 0 when nothing matches. */
static DWORD find_pid_by_name(const wchar_t *query, wchar_t *outName, size_t outCch)
{
    HANDLE         snap;
    PROCESSENTRY32W pe;
    DWORD          found = 0;
    const wchar_t *base = query;
    const wchar_t *slash = wcsrchr(query, L'\\');

    if (slash != NULL) {
        base = slash + 1;
    }

    snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) {
        return 0;
    }

    ZeroMemory(&pe, sizeof(pe));
    pe.dwSize = sizeof(pe);

    if (Process32FirstW(snap, &pe)) {
        do {
            /* pid 0 is the idle process, pid 4 the system process: no image name. */
            if (pe.th32ProcessID == 0 || pe.th32ProcessID == 4) {
                continue;
            }
            if (exe_name_matches(base, pe.szExeFile)) {
                found = pe.th32ProcessID;
                if (outName != NULL) {
                    copy_w(outName, outCch, pe.szExeFile);
                }
                break;
            }
        } while (Process32NextW(snap, &pe));
    }

    CloseHandle(snap);
    return found;
}

/* Image file name (no directory) of an open process, best effort. */
static BOOL get_image_base_name(HANDLE hProc, wchar_t *out, size_t outCch)
{
    wchar_t full[MAX_PATH * 4];
    DWORD   n = (DWORD)ARRAY_LEN(full);
    const wchar_t *base;

    full[0] = L'\0';
    if (!QueryFullProcessImageNameW(hProc, 0, full, &n)) {
        return FALSE;
    }
    base = wcsrchr(full, L'\\');
    copy_w(out, outCch, base != NULL ? base + 1 : full);
    return TRUE;
}

/* ------------------------------------------------------- architecture check */

static const wchar_t *machine_arch_name(USHORT machine)
{
    switch (machine) {
    case IMAGE_FILE_MACHINE_I386:  return L"x86";
    case IMAGE_FILE_MACHINE_AMD64: return L"x64";
    case IMAGE_FILE_MACHINE_ARM64: return L"arm64";
    case IMAGE_FILE_MACHINE_ARMNT:
    case IMAGE_FILE_MACHINE_ARM:   return L"arm";
    default:                       return L"unknown";
    }
}

/*
 * Machine type the process actually runs as.
 * IsWow64Process2 (Win10 1709+) answers this exactly; on older systems the
 * IsWow64Process + native-system-info fallback is used.
 */
static BOOL detect_target_machine(HANDLE hProc, USHORT *outMachine)
{
    typedef BOOL (WINAPI *PFN_IsWow64Process2)(HANDLE, USHORT *, USHORT *);
    static PFN_IsWow64Process2 fn = NULL;
    static BOOL                resolved = FALSE;

    if (!resolved) {
        HMODULE k32 = GetModuleHandleW(L"kernel32.dll");

        if (k32 != NULL) {
            fn = (PFN_IsWow64Process2)(void *)GetProcAddress(k32, "IsWow64Process2");
        }
        resolved = TRUE;
    }

    if (fn != NULL) {
        USHORT processMachine = 0;
        USHORT nativeMachine  = 0;

        if (fn(hProc, &processMachine, &nativeMachine)) {
            /* UNKNOWN means "not emulated": the process runs as the native arch. */
            *outMachine = (processMachine == IMAGE_FILE_MACHINE_UNKNOWN)
                              ? nativeMachine
                              : processMachine;
            return TRUE;
        }
    }

    {
        BOOL        wow64 = FALSE;
        SYSTEM_INFO si;

        if (!IsWow64Process(hProc, &wow64)) {
            return FALSE;
        }
        GetNativeSystemInfo(&si);
        if (si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ||
            si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_ARM64) {
            *outMachine = wow64 ? IMAGE_FILE_MACHINE_I386 : IMAGE_FILE_MACHINE_AMD64;
        } else {
            *outMachine = IMAGE_FILE_MACHINE_I386;
        }
        return TRUE;
    }
}

/* --------------------------------------------------------------- privilege */

/* Best effort: injecting into another user's process needs SeDebugPrivilege. */
static BOOL enable_debug_privilege(DWORD *outError)
{
    HANDLE           token = NULL;
    TOKEN_PRIVILEGES tp;
    BOOL             ok = FALSE;
    DWORD            err = ERROR_SUCCESS;

    if (outError != NULL) {
        *outError = ERROR_SUCCESS;
    }
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token)) {
        if (outError != NULL) {
            *outError = GetLastError();
        }
        return FALSE;
    }

    ZeroMemory(&tp, sizeof(tp));
    tp.PrivilegeCount = 1;
    if (LookupPrivilegeValueW(NULL, SE_DEBUG_NAME, &tp.Privileges[0].Luid)) {
        tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
        SetLastError(ERROR_SUCCESS);
        if (AdjustTokenPrivileges(token, FALSE, &tp, sizeof(tp), NULL, NULL)) {
            err = GetLastError(); /* ERROR_NOT_ALL_ASSIGNED when the token lacks it */
            ok = (err == ERROR_SUCCESS);
        } else {
            err = GetLastError();
        }
    } else {
        err = GetLastError();
    }

    CloseHandle(token);
    if (outError != NULL) {
        *outError = err;
    }
    return ok;
}

/* ------------------------------------------------------------------- usage */

static void print_usage(void)
{
    fputs(
        "wechat-inject - inject a DLL into a running Windows process\n"
        "\n"
        "Usage:\n"
        "  wechat-inject.exe --process <image>  --dll <dll path> [--timeout <ms>] [--json]\n"
        "  wechat-inject.exe --pid <pid>        --dll <dll path> [--timeout <ms>] [--json]\n"
        "\n"
        "Options:\n"
        "  --process   image name, case-insensitive, e.g. WeChat.exe (first match wins)\n"
        "  --pid       process id (alternative to --process)\n"
        "  --dll       path to the DLL to inject (absolute or relative)\n"
        "  --timeout   ms to wait for the remote LoadLibraryW thread (default 15000)\n"
        "  --json      print exactly one JSON line on stdout\n"
        "  -h, --help  show this help\n"
        "\n"
        "Exit codes: 0 ok, 1 bad usage, 2 process not found, 3 open process failed,\n"
        "            4 architecture mismatch, 5 injection failed\n",
        stdout);
}

/* ------------------------------------------------------------ option parse */

/* Match "--name" or "--name=value"; *inlineValue is set for the "=" form. */
static BOOL opt_is(const wchar_t *arg, const wchar_t *name, const wchar_t **inlineValue)
{
    size_t n = wcslen(name);

    if (_wcsnicmp(arg, name, n) != 0) {
        return FALSE;
    }
    if (arg[n] == L'\0') {
        *inlineValue = NULL;
        return TRUE;
    }
    if (arg[n] == L'=') {
        *inlineValue = arg + n + 1;
        return TRUE;
    }
    return FALSE;
}

/* -------------------------------------------------------------------- main */

int main(void)
{
    int          argc = 0;
    LPWSTR      *argv = NULL;
    Options      opt;
    wchar_t      dllFull[MAX_PATH * 4];
    wchar_t      procName[256];
    wchar_t      msg[1024];
    wchar_t      targetArch[16];
    DWORD        pid = 0;
    DWORD        winErr = 0;
    SIZE_T       written = 0;
    USHORT       targetMachine = IMAGE_FILE_MACHINE_UNKNOWN;
    HANDLE       hProc = NULL;
    HANDLE       hThread = NULL;
    LPVOID       remoteMem = NULL;
    SIZE_T       pathBytes = 0;
    int          i;
    int          rc = EXIT_OK;
    FARPROC      loadLibraryW = NULL;

    SetConsoleOutputCP(CP_UTF8);

    ZeroMemory(&opt, sizeof(opt));
    opt.timeoutMs = DEFAULT_TIMEOUT_MS;
    dllFull[0] = L'\0';
    procName[0] = L'\0';
    targetArch[0] = L'\0';

    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv == NULL) {
        fputs("error: CommandLineToArgvW failed\n", stderr);
        return EXIT_USAGE;
    }

    /*
     * Detect --json up front so that argument errors are also reported as one
     * JSON line (JSON mode promises: stdout carries nothing but that line).
     */
    for (i = 1; i < argc; ++i) {
        if (_wcsicmp(argv[i], L"--json") == 0) {
            opt.json = TRUE;
            break;
        }
    }

    for (i = 1; i < argc; ++i) {
        const wchar_t *inlineValue = NULL;
        const wchar_t *value = NULL;

        if (opt_is(argv[i], L"--json", &inlineValue)) {
            opt.json = TRUE;
            continue;
        }
        if (opt_is(argv[i], L"--help", &inlineValue) || opt_is(argv[i], L"-h", &inlineValue)) {
            print_usage();
            LocalFree(argv);
            return EXIT_OK;
        }
        if (opt_is(argv[i], L"--process", &inlineValue)) {
            value = inlineValue;
            if (value == NULL && i + 1 < argc) {
                value = argv[++i];
            }
            if (value == NULL || value[0] == L'\0') {
                rc = fail_with(&opt, "bad-usage", EXIT_USAGE, L"--process needs a value", 0);
                if (!opt.json) {
                    print_usage();
                }
                LocalFree(argv);
                return rc;
            }
            opt.processName = value;
            continue;
        }
        if (opt_is(argv[i], L"--dll", &inlineValue)) {
            value = inlineValue;
            if (value == NULL && i + 1 < argc) {
                value = argv[++i];
            }
            if (value == NULL || value[0] == L'\0') {
                rc = fail_with(&opt, "bad-usage", EXIT_USAGE, L"--dll needs a value", 0);
                if (!opt.json) {
                    print_usage();
                }
                LocalFree(argv);
                return rc;
            }
            opt.dllPath = value;
            continue;
        }
        if (opt_is(argv[i], L"--pid", &inlineValue)) {
            wchar_t *end = NULL;

            value = inlineValue;
            if (value == NULL && i + 1 < argc) {
                value = argv[++i];
            }
            if (value == NULL) {
                rc = fail_with(&opt, "bad-usage", EXIT_USAGE, L"--pid needs a value", 0);
                if (!opt.json) {
                    print_usage();
                }
                LocalFree(argv);
                return rc;
            }
            opt.pid = (DWORD)wcstoul(value, &end, 10);
            if (end == value || (end != NULL && *end != L'\0') || opt.pid == 0) {
                rc = fail_with(&opt, "bad-usage", EXIT_USAGE,
                               L"--pid must be a positive integer", 0);
                if (!opt.json) {
                    print_usage();
                }
                LocalFree(argv);
                return rc;
            }
            continue;
        }
        if (opt_is(argv[i], L"--timeout", &inlineValue)) {
            wchar_t *end = NULL;
            unsigned long v;

            value = inlineValue;
            if (value == NULL && i + 1 < argc) {
                value = argv[++i];
            }
            if (value == NULL) {
                rc = fail_with(&opt, "bad-usage", EXIT_USAGE,
                               L"--timeout needs a value in milliseconds", 0);
                if (!opt.json) {
                    print_usage();
                }
                LocalFree(argv);
                return rc;
            }
            v = wcstoul(value, &end, 10);
            if (end == value || (end != NULL && *end != L'\0') || v < 1 || v > 600000UL) {
                rc = fail_with(&opt, "bad-usage", EXIT_USAGE,
                               L"--timeout must be 1..600000 ms", 0);
                if (!opt.json) {
                    print_usage();
                }
                LocalFree(argv);
                return rc;
            }
            opt.timeoutMs = (DWORD)v;
            continue;
        }

        _snwprintf(msg, ARRAY_LEN(msg), L"unknown argument: %ls", argv[i]);
        msg[ARRAY_LEN(msg) - 1] = L'\0';
        rc = fail_with(&opt, "bad-usage", EXIT_USAGE, msg, 0);
        if (!opt.json) {
            print_usage();
        }
        LocalFree(argv);
        return rc;
    }

    /* ---- validate ------------------------------------------------------- */
    if (opt.dllPath == NULL) {
        rc = fail_with(&opt, "bad-usage", EXIT_USAGE, L"missing --dll <path>", 0);
        LocalFree(argv);
        return rc;
    }
    if ((opt.processName == NULL) == (opt.pid == 0)) {
        rc = fail_with(&opt, "bad-usage", EXIT_USAGE,
                       L"give exactly one of --process <image> or --pid <pid>", 0);
        LocalFree(argv);
        return rc;
    }

    if (GetFullPathNameW(opt.dllPath, (DWORD)ARRAY_LEN(dllFull), dllFull, NULL) == 0 ||
        GetFileAttributesW(dllFull) == INVALID_FILE_ATTRIBUTES) {
        _snwprintf(msg, ARRAY_LEN(msg), L"DLL not found or path invalid: %ls", opt.dllPath);
        msg[ARRAY_LEN(msg) - 1] = L'\0';
        rc = fail_with(&opt, "bad-usage", EXIT_USAGE, msg, 0);
        LocalFree(argv);
        return rc;
    }

    /* ---- resolve the target process ------------------------------------- */
    if (opt.pid != 0) {
        pid = opt.pid;
    } else {
        pid = find_pid_by_name(opt.processName, procName, ARRAY_LEN(procName));
        if (pid == 0) {
            _snwprintf(msg, ARRAY_LEN(msg),
                       L"no running process matches image name '%ls'", opt.processName);
            msg[ARRAY_LEN(msg) - 1] = L'\0';
            rc = fail_with(&opt, "process-not-found", EXIT_PROCESS_NOT_FOUND, msg, 0);
            LocalFree(argv);
            return rc;
        }
    }

    /* ---- SeDebugPrivilege (not fatal) ----------------------------------- */
    if (!enable_debug_privilege(&winErr)) {
        if (opt.json) {
            /* JSON mode keeps stdout to a single line; report nothing extra. */
        } else {
            wchar_t emsg[512];

            win_error_msg(emsg, ARRAY_LEN(emsg), L"note: SeDebugPrivilege not enabled", winErr);
            print_w(stderr, emsg);
            fputs("; continuing anyway\n", stderr);
        }
    }

    /* ---- open the process ------------------------------------------------ */
    hProc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                            PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                        FALSE, pid);
    if (hProc == NULL) {
        winErr = GetLastError();
        win_error_msg(msg, ARRAY_LEN(msg), L"OpenProcess failed", winErr);
        rc = fail_with(&opt, "open-process-failed", EXIT_OPEN_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }

    if (procName[0] == L'\0') {
        (void)get_image_base_name(hProc, procName, ARRAY_LEN(procName));
    }

    /* ---- architecture check --------------------------------------------- */
    if (!detect_target_machine(hProc, &targetMachine)) {
        winErr = GetLastError();
        win_error_msg(msg, ARRAY_LEN(msg), L"cannot determine target architecture", winErr);
        CloseHandle(hProc);
        rc = fail_with(&opt, "open-process-failed", EXIT_OPEN_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }
    copy_w(targetArch, ARRAY_LEN(targetArch), machine_arch_name(targetMachine));

    if (targetMachine != (USHORT)INJECTOR_MACHINE) {
        _snwprintf(msg, ARRAY_LEN(msg),
                   L"architecture mismatch: target=%ls injector=%ls; the injector must match "
                   L"the target architecture (a 32-bit target requires a 32-bit injector)",
                   targetArch, machine_arch_name((USHORT)INJECTOR_MACHINE));
        msg[ARRAY_LEN(msg) - 1] = L'\0';
        CloseHandle(hProc);
        rc = fail_with(&opt, "arch-mismatch", EXIT_ARCH_MISMATCH, msg, pid);
        LocalFree(argv);
        return rc;
    }

    /* ---- classic injection ---------------------------------------------- */
    pathBytes = (wcslen(dllFull) + 1) * sizeof(wchar_t);

    remoteMem = VirtualAllocEx(hProc, NULL, pathBytes, MEM_COMMIT | MEM_RESERVE,
                               PAGE_READWRITE);
    if (remoteMem == NULL) {
        winErr = GetLastError();
        win_error_msg(msg, ARRAY_LEN(msg), L"VirtualAllocEx failed", winErr);
        CloseHandle(hProc);
        rc = fail_with(&opt, "alloc-failed", EXIT_INJECT_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }

    if (!WriteProcessMemory(hProc, remoteMem, dllFull, pathBytes, &written) ||
        written != pathBytes) {
        winErr = GetLastError();
        win_error_msg(msg, ARRAY_LEN(msg), L"WriteProcessMemory failed", winErr);
        VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        rc = fail_with(&opt, "write-failed", EXIT_INJECT_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }

    /*
     * kernel32 is mapped at the same base address in every process of the same
     * architecture on the same boot, so our own LoadLibraryW address is valid
     * inside the target (this is the standard CreateRemoteThread trick).
     */
    loadLibraryW = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    if (loadLibraryW == NULL) {
        winErr = GetLastError();
        win_error_msg(msg, ARRAY_LEN(msg), L"GetProcAddress(LoadLibraryW) failed", winErr);
        VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        rc = fail_with(&opt, "thread-failed", EXIT_INJECT_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }

    hThread = CreateRemoteThread(hProc, NULL, 0,
                                 (LPTHREAD_START_ROUTINE)(void *)loadLibraryW, remoteMem, 0, NULL);
    if (hThread == NULL) {
        winErr = GetLastError();
        win_error_msg(msg, ARRAY_LEN(msg), L"CreateRemoteThread failed", winErr);
        VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
        CloseHandle(hProc);
        rc = fail_with(&opt, "thread-failed", EXIT_INJECT_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }

    winErr = WaitForSingleObject(hThread, opt.timeoutMs);
    if (winErr == WAIT_TIMEOUT) {
        _snwprintf(msg, ARRAY_LEN(msg),
                   L"remote LoadLibraryW thread did not finish within %lu ms",
                   (unsigned long)opt.timeoutMs);
        msg[ARRAY_LEN(msg) - 1] = L'\0';
        CloseHandle(hThread);
        CloseHandle(hProc);
        rc = fail_with(&opt, "timeout", EXIT_INJECT_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }
    if (winErr != WAIT_OBJECT_0) {
        winErr = GetLastError();
        win_error_msg(msg, ARRAY_LEN(msg), L"WaitForSingleObject failed", winErr);
        CloseHandle(hThread);
        CloseHandle(hProc);
        rc = fail_with(&opt, "thread-failed", EXIT_INJECT_FAILED, msg, pid);
        LocalFree(argv);
        return rc;
    }

    {
        DWORD exitCode = 0;

        if (!GetExitCodeThread(hThread, &exitCode)) {
            winErr = GetLastError();
            win_error_msg(msg, ARRAY_LEN(msg), L"GetExitCodeThread failed", winErr);
            CloseHandle(hThread);
            CloseHandle(hProc);
            rc = fail_with(&opt, "thread-failed", EXIT_INJECT_FAILED, msg, pid);
            LocalFree(argv);
            return rc;
        }
        if (exitCode == 0) {
            _snwprintf(msg, ARRAY_LEN(msg),
                       L"LoadLibraryW returned NULL in the target (pid %lu); "
                       L"check that the DLL exists, matches the target architecture "
                       L"and has all of its dependencies available",
                       (unsigned long)pid);
            msg[ARRAY_LEN(msg) - 1] = L'\0';
            CloseHandle(hThread);
            CloseHandle(hProc);
            rc = fail_with(&opt, "thread-failed", EXIT_INJECT_FAILED, msg, pid);
            LocalFree(argv);
            return rc;
        }

        /* ---- success ---------------------------------------------------- */
        if (opt.json) {
            emit_json_ok(pid, procName, dllFull, machine_arch_name((USHORT)INJECTOR_MACHINE),
                         machine_arch_name(targetMachine));
        } else {
            printf("process : %ls (pid %lu)\n", procName[0] != L'\0' ? procName : L"<pid>",
                   (unsigned long)pid);
            print_w(stdout, L"dll     : ");
            print_w(stdout, dllFull);
            printf("\ninjector: %ls, target: %ls\n",
                   machine_arch_name((USHORT)INJECTOR_MACHINE),
                   machine_arch_name(targetMachine));
            /*
             * CreateRemoteThread exports a 32-bit exit code, so a 64-bit module
             * handle may be truncated here; non-zero is still a solid success
             * signal for LoadLibraryW.
             */
            printf("result  : OK (LoadLibraryW returned 0x%08lX, DWORD-truncated handle)\n",
                   (unsigned long)exitCode);
        }
    }

    CloseHandle(hThread);
    /* The remote string has been consumed by LoadLibraryW by now. */
    VirtualFreeEx(hProc, remoteMem, 0, MEM_RELEASE);
    CloseHandle(hProc);
    LocalFree(argv);
    return EXIT_OK;
}
