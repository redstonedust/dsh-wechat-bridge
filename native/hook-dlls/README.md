# hook-dlls —— 放「与微信版本匹配」的 hook DLL

这个目录是 `native/resolve-hook-dll.mjs` 和插件注入编排的**本地 DLL 仓库**。
DLL 与微信版本强绑定：版本不对，注进去微信会直接崩，所以本仓库不预置任何 DLL，
也不内置下载地址——你放什么，它就用什么。

## 放法（任选其一）

**1) 文件名带版本（最省事）**

```
native/hook-dlls/sdk-3.9.12.17.dll
```

解析器会按 `3.9.12.17` 精确命中；同 `3.9.12.*`、同 `3.9.*` 也会按前缀命中。

**2) 用清单登记（推荐，能校验完整性）**

`native/hook-dlls/hook-catalog.json`：

```json
{
  "3.9.12.17": { "file": "sdk.dll", "sha256": "<64 位十六进制>", "note": "WeChatFerry" },
  "3.9.12.*":  { "file": "sdk-3.9.12.dll" },
  "3.9.*":     { "any": true, "file": "sdk-3.9-legacy.dll", "note": "自己保证兼容" }
}
```

- `sha256` 写了就会校验；不匹配直接拒绝（`hash-mismatch`）。
- `"any": true` 是「兜底通配」，只在没有精确/前缀命中时使用。

## 怎么确认版本

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native\probe-wechat.ps1   # 或
node native\detect-wechat.mjs
```

> **Weixin 4.x 没有可用的 hook DLL**（4.x 是另一套客户端，公开的 hook 生态只覆盖 WeChat 3.9.x）。
> 探测脚本会直接告你 `unsupported`。要用注入这条路，装一个 3.9.x 的 WeChat 与 4.x 共存即可。

## 校验

```powershell
node native\resolve-hook-dll.mjs --list
node native\resolve-hook-dll.mjs --version 3.9.12.17
```
