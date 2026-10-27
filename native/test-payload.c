/*
 * test-payload.c -- self-test DLL for wechat-inject.
 *
 * On DLL_PROCESS_ATTACH it writes one line to
 *   %TEMP%\wechat-inject-selftest-<pid>.txt
 * containing its own pid, a timestamp and the module path. The marker file
 * proves the DLL really executed inside the target process (not in the
 * injector, which never loads it).
 *
 * Build (x64):
 *   gcc -O2 -Wall -Wextra -static -shared -o build\test-payload.dll test-payload.c -luser32
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

#define BUF_LEN(a) (sizeof(a) / sizeof((a)[0]))

static void write_marker(HINSTANCE hinst)
{
    wchar_t    tmp[MAX_PATH + 2];
    wchar_t    file[MAX_PATH * 2];
    wchar_t    self[MAX_PATH * 2];
    SYSTEMTIME st;
    DWORD      pid = GetCurrentProcessId();
    DWORD      written = 0;
    char       line[1024];
    int        len;
    HANDLE     h;

    /* GetTempPathW returns the per-user TEMP with a trailing backslash. */
    tmp[0] = L'\0';
    if (GetTempPathW((DWORD)BUF_LEN(tmp), tmp) == 0) {
        tmp[0] = L'\0';
    }

    file[0] = L'\0';
    _snwprintf(file, BUF_LEN(file), L"%lswechat-inject-selftest-%lu.txt",
               tmp, (unsigned long)pid);
    file[BUF_LEN(file) - 1] = L'\0';

    h = CreateFileW(file, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                    CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return;
    }

    GetLocalTime(&st);
    self[0] = L'\0';
    GetModuleFileNameW(hinst, self, (DWORD)BUF_LEN(self));
    self[BUF_LEN(self) - 1] = L'\0';

    len = _snprintf(line, sizeof(line),
                    "pid=%lu\r\n"
                    "loaded_at=%04u-%02u-%02u %02u:%02u:%02u.%03u\r\n"
                    "module=%ls\r\n"
                    "marker=%ls\r\n",
                    (unsigned long)pid,
                    (unsigned int)st.wYear, (unsigned int)st.wMonth, (unsigned int)st.wDay,
                    (unsigned int)st.wHour, (unsigned int)st.wMinute, (unsigned int)st.wSecond,
                    (unsigned int)st.wMilliseconds,
                    self, file);
    if (len > 0) {
        WriteFile(h, line, (DWORD)len, &written, NULL);
    }
    CloseHandle(h);
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved)
{
    (void)reserved;

    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        /*
         * File APIs inside DllMain are not formally endorsed (loader lock), but
         * this payload only does one synchronous write and is never unloaded,
         * so it is safe enough for a self-test fixture.
         */
        write_marker(hinst);
    }
    return TRUE;
}
