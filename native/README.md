# native/ — 微信 DLL 注入器（wechat-inject）

一个零第三方依赖的 Win32 DLL 注入器 + 一套能真跑通的自测夹具。
后面接微信 hook（WeChatFerry 那类 SDK DLL）时，用 `wechat-inject.exe` 把 SDK DLL 注进 `WeChat.exe` 即可。

> 安全边界：只在你自己的机器、你自己的微信上用。

## 产物

| 产物 | 说明 |
| --- | --- |
| `build/wechat-inject.exe` | CLI 注入器。按镜像名或 pid 找进程，校验位数后用 `CreateRemoteThread` + `LoadLibraryW` 注入任意 DLL |
| `build/test-payload.dll` | 自测 DLL。`DllMain(DLL_PROCESS_ATTACH)` 时往目标进程的 `%TEMP%\wechat-inject-selftest-<pid>.txt` 写 pid / 时间戳 / 模块路径，用来证明 DLL 真的在目标进程里跑起来了 |
| `build/test-target.exe` | 自测靶子。打印自己的 pid，`Sleep(30000)` 后退出，不干别的 |

源码：`wechat-inject.c`、`test-payload.c`、`test-target.c`。

## 构建

```powershell
# 普通构建
powershell -NoProfile -ExecutionPolicy Bypass -File native\build.ps1

# 清空 native\build 后重新构建
powershell -NoProfile -ExecutionPolicy Bypass -File native\build.ps1 -Clean
```

要求：`gcc` 在 PATH 里（MinGW-w64 x86_64，`gcc -dumpmachine` 看到 `x86_64-w64-mingw32`）。
build.ps1 用 `-O2 -Wall -Wextra -static` 编译，gcc 报错原样打出来，失败就非 0 退出。
`-static` 是为了产物只依赖系统 DLL（kernel32/msvcrt），不会因为缺 `libgcc_s_seh-1.dll` 而在目标进程里加载失败。

产物依赖可以用 `objdump -p build\wechat-inject.exe | findstr "DLL Name"` 自查。

## 自测

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native\test-inject.ps1

# 产物已存在时跳过编译
powershell -NoProfile -ExecutionPolicy Bypass -File native\test-inject.ps1 -SkipBuild
```

脚本会依次做：

1. 跑 `build.ps1`，检查三个产物都在；
2. 起 `build\test-target.exe`，拿 pid；
3. `wechat-inject.exe --pid <pid> --dll <abs path to test-payload.dll> --json`，解析 JSON；
4. 断言 `ok=true`，并在 3 秒内等到 `%TEMP%\wechat-inject-selftest-<pid>.txt`；
5. 错误路径：`--process definitely-not-running.exe` 必须给出 `code=process-not-found` 且退出码非 0；
6. 杀掉靶子进程，逐步打印结果，有失败就非 0 退出。

全绿输出末尾是：

```
全部通过: 16 项断言
```

> 自测会把靶子进程的 `TEMP`/`TMP` 指到 `native\build\selftest-tmp`。这样 marker 落在仓库里、不污染真实 `%TEMP%`，
> 并且在低完整性（沙箱 / 受限令牌）环境里也能写——那种环境下目标进程往往没有真实 `%TEMP%` 的写权限。
> marker 路径仍然是 DLL 自己用 `GetTempPathW` 算出来的，即"目标进程的 `%TEMP%`"。

## 用法

```text
wechat-inject.exe --process WeChat.exe --dll C:\path\sdk.dll [--timeout 15000] [--json]
wechat-inject.exe --pid 1234 --dll C:\path\sdk.dll [--timeout 15000] [--json]
```

- `--process`：镜像名，不区分大小写，取快照里第一个匹配（也可以只写 `WeChat`，等价于 `WeChat.exe`）。
- `--pid`：直接给进程号，和 `--process` 二选一。
- `--dll`：DLL 路径，绝对/相对都行，内部会转成绝对路径。
- `--timeout`：等远程 `LoadLibraryW` 线程的毫秒数，默认 15000。
- `--json`：stdout 只输出一行 JSON，方便脚本/上层 hook 流程消费。

成功：

```json
{"ok":true,"pid":27428,"process":"test-target.exe","dll":"C:\\DSH\\dsh-wechat\\native\\build\\test-payload.dll","injector":"x64","target":"x64"}
```

失败：

```json
{"ok":false,"code":"process-not-found","message":"no running process matches image name 'definitely-not-running.exe'","pid":0}
```

`code` 取值：`bad-usage`、`process-not-found`、`open-process-failed`、`arch-mismatch`、`alloc-failed`、`write-failed`、`thread-failed`、`timeout`。

退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 用法错误（缺参数、DLL 路径不存在等） |
| 2 | 找不到进程 |
| 3 | `OpenProcess` 失败（权限不足、进程已退出） |
| 4 | 位数不匹配（32 位目标 vs 64 位注入器） |
| 5 | 注入失败（分配 / 写入 / 建线程 / 超时） |

## 接微信

```powershell
native\build\wechat-inject.exe --process WeChat.exe --dll C:\path\to\sdk.dll
```

想先确认注入成功，加 `--json` 看 `ok=true`，或者看 SDK 自己的日志/窗口。

三条硬要求，缺一个都只会看到 `thread-failed`（`LoadLibraryW` 返回 0）：

1. **DLL 必须和微信版本匹配**。WeChatFerry 这类 SDK 是按微信版本硬编码偏移的，版本对不上，DLL 加载得进去但 hook 会崩或静默失效。
2. **位数要对上**。64 位微信要 64 位 DLL（本仓库的注入器是 x64）；如果目标真的是 32 位进程，注入器会直接以 `arch-mismatch`（退出码 4）拒绝，而不是瞎试——那种情况得用 32 位编译的注入器和 32 位 DLL。
3. **微信要先登录**。登录前注入，SDK 初始化时拿不到消息管理器的上下文，通常直接失败。

另外：如果微信是管理员权限跑的，注入器也得用管理员权限跑（否则 `OpenProcess` 是 `open-process-failed`，退出码 3）。
注入器会先尝试启用 `SeDebugPrivilege`，失败不致命，继续尝试。

## 实现要点

- 找进程：`CreateToolhelp32Snapshot` + `Process32FirstW/Process32NextW`，镜像名大小写不敏感，取第一个匹配。
- 打开进程：`PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ`。
- 位数校验：优先 `IsWow64Process2`，老系统回退到 `IsWow64Process` + `GetNativeSystemInfo`。不匹配直接退出，不做无意义的注入尝试。
- 注入：`VirtualAllocEx(MEM_COMMIT|MEM_RESERVE, PAGE_READWRITE)` → 写宽字符 DLL 路径 → `GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW")` → `CreateRemoteThread` → `WaitForSingleObject` → `GetExitCodeThread`。
- 同架构下 kernel32 在各进程的加载基址一致，所以本进程里拿到的 `LoadLibraryW` 地址在目标进程里同样有效。
- `CreateRemoteThread` 的返回值是 `DWORD`，高地址下模块句柄会被截断；非 0 即视为成功（文本模式会把截断后的值打出来）。
- 失败时用 `FormatMessageW` 拼可读错误并带 `GetLastError()` 数值。

## 说明

- `*.ps1` 是 UTF-8 **带 BOM** + CRLF（见仓库 `.gitattributes` 的 `*.ps1 text eol=crlf`）；PS 5.1 没有 BOM 时中文注释会解析失败。改动脚本请保持。
- `native/build/` 是构建产物，已在 `native/.gitignore` 里忽略。
