/*
 * test-target.c -- harmless injection target for wechat-inject self-tests.
 *
 * Prints its pid and sleeps for 30 seconds, then exits. It does nothing else,
 * so it is safe to inject into and safe to kill.
 *
 * Build (x64):
 *   gcc -O2 -Wall -Wextra -static -o build\test-target.exe test-target.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

int main(void)
{
    printf("test-target pid=%lu sleeping 30000 ms\n", (unsigned long)GetCurrentProcessId());
    fflush(stdout);
    Sleep(30000);
    return 0;
}
