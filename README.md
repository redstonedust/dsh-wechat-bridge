# dsh-wechat-bridge

**100% vibe coding 的 DSH 桥接到微信的插件。**

一个把微信接进 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的 Host 插件 + 一个配套 agent 模式。微信只当"嘴和耳朵"，脑子是 DSH 里的 agent。

```
       微信侧                       DSH Host（127.0.0.1:43120）
 ┌──────────────┐   POST /wechat/webhook   ┌────────────────────────────┐
 │ 公众号 /      │ ───────────────────────▶ │ wechat-bridge 插件          │
 │ WeChatFerry / │   （JSON 或 XML+签名）    │  ├ 入站解析 → 会话/消息表    │
 │ Gewechat /    │                          │  ├ autoReply? ──▶ Agent     │
 │ 自建网关      │ ◀─────────────────────── │  │   （preset: wechat-agent）│
 └──────────────┘   {action:"send",...}    │  └ turn/end → 原样投递      │
                                           └────────────────────────────┘
                                                     ▲  工具面 12 个
                                                     │  wechat_send_message …
                                              任意 agent 会话
```

## 个人微信（hook）

个人微信没有公开 API，链路一定是「微信客户端 → 本机 hook 服务 → 插件」：

```
微信客户端 ──(注入/hook)──▶ hook 服务 ──(HTTP 轮询)──▶ dsh-wechat-bridge ──▶ DSH agent
                                  ▲                              │
                                  └────────(POST /send)──────────┘
```

插件侧只认两个端点，`gateway/hook-gateway.mjs` 负责跟真实 hook 打交道：

```yaml
config:
  kind: hook
  hook:
    baseUrl: 'http://127.0.0.1:8788'
    secret: 'change-me'
    pollMs: 3000
    selfIds: ['wxid_bot']    # 机器人自己的 wxid，防自问自答
```

```powershell
# 不装微信，先把链路跑通（mock 驱动）
node gateway/hook-gateway.mjs --driver mock --port 8788 --secret change-me

# 接 WeChatFerry 的 HTTP 封装
node gateway/hook-gateway.mjs --driver wcf --port 8788 --secret change-me --wcf-base http://127.0.0.1:9999

# 接任何自己的 hook 脚本（stdout 出 JSON 即可）
node gateway/hook-gateway.mjs --driver exec --port 8788 --secret change-me `
  --get-cmd "python my_hook.py pull {{cursor}} {{limit}}" `
  --send-cmd "python my_hook.py send {{chatId}} {{text}}"
```

细节（游标语义、字段映射、wcf 路径/方法名适配）见 [gateway/README.md](gateway/README.md)。
面板「控制台 → 个人微信 Hook」可以看游标/最近错误、手动拉一次、随时开关轮询。

### 一键接入：探测 → 选 DLL → 注入 → 起网关 → 写配置 → 自检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-hook.ps1
#   或先看会做什么（不编译、不注入、不改配置）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-hook.ps1 -DryRun
```

脚本会**先探测再决定**，不会拿一个不匹配的 DLL 硬注：

| 探测结果 | 判定 | 一键脚本的行为 |
|---|---|---|
| WeChat **3.9.x**（`WeChat.exe`） | `wcferry-dll` | 按版本解析 DLL → 编译注入器（没编过才编）→ 注入 → 起网关 → 写插件配置 → 自检 |
| Weixin **4.x**（`Weixin.exe`） | `unsupported` | **拒绝注入**，打印原因与替代路线后退出（exit 2） |
| 没装微信 | `none` | 提示先安装 |

**为什么 4.x 不行（实测，不是猜）**：Weixin 4.x 是另一套客户端；公开的 hook DLL 生态只覆盖 3.9.x，
而它的界面是 Qt 自绘——UIA 探针在这台机器上只数到 **24 个后代节点**（全 Group/Button/Text，**没有 List/Edit**），
所以既没有可注入的 DLL，也无法用 UI Automation 读会话。

两条真正能用的路线：

1. **装一个微信 3.9.x**（可与 4.x 共存，装到别的目录）→ 重跑 `setup-hook.ps1`，全功能注入；
2. **走官方通道**：公众号 / 企业微信 / 微信客服（本插件 `kind=official` / `wecom` 已支持）。

### 版本适配是怎么做的

```
native/detect-wechat.mjs     注册表 + 常见路径 + PE 头 → 家族/版本/架构/进程/窗口 → 判定 strategy
native/resolve-hook-dll.mjs  版本 → native/hook-dlls/ 里的 DLL（精确 → 3.9.12.* → 3.9.* → 通配）
                              可选 sha256 校验；没命中就告诉你「放成 sdk-<版本>.dll」
native/probe-uia.ps1         只在需要评估 UI Automation 可行性时用（会数节点类型）
```

DLL 放法：`native/hook-dlls/sdk-3.9.12.17.dll`，或用 `hook-catalog.json` 登记（可带 sha256）。
插件配置 `inject.autoDetect: true`（默认）后，面板点「注入微信」也会走同一套探测+解析。

### 注入微信

个人微信的消息能力来自那个 **hook DLL**，而 DLL 要先被加载进微信进程。仓库自带一个 Win32 注入器：

```powershell
cd native
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1      # 需要 MinGW gcc（PATH 里）
powershell -NoProfile -ExecutionPolicy Bypass -File test-inject.ps1 # 自测：注入到自己起的靶子进程
node ..\scripts\test-inject.mjs                                    # 自测：走插件那条编排路径
```

然后在面板「设置 → 网关 → 个人微信 Hook」里填两样东西：**hook DLL 路径**（例如 WeChatFerry 的 `sdk.dll`）和**进程名**（默认 `WeChat.exe`），
再到「控制台 → 个人微信 Hook」点 **注入微信** —— 插件会：

```
调注入器（--process WeChat.exe --dll <你的 DLL> --json）
  → 解析结果（pid / 架构 / 错误码）
  → 等 <hook.baseUrl>/health 就绪（最长 inject.waitForServiceMs）
  → 自动开始轮询
```

等价的两个入口：

```powershell
# 直接命令行注入（不经过插件）
native\build\wechat-inject.exe --process WeChat.exe --dll C:\path\sdk.dll --json

# 让 agent 自己做
wechat_hook({ action: "inject" })
```

配置：

```yaml
inject:
  injectorPath: ./native/build/wechat-inject.exe
  processName: WeChat.exe
  wechatPath: ''           # 填了就先拉起微信再注入
  hookDll: 'C:\path\sdk.dll'
  timeoutMs: 15000
  waitForServiceMs: 20000
```

**注意**：DLL 必须与你本机微信版本、架构（32/64 位）匹配，不匹配会让微信直接崩；注入前微信要已登录；
这套东西只在自己机器、自己的微信上用。

## 它做什么

- **接微信**：四种网关——`generic`（自建网关 webhook）、`official`（公众号，含签名验签）、`wecom`（企微群机器人，只出站）、**`hook`（个人微信，插件主动轮询本机 hook 服务）**。
- **个人微信 hook**：附带 [gateway/hook-gateway.mjs](gateway/hook-gateway.mjs)，把 WeChatFerry / 你自己的 hook 脚本收敛成统一协议；`mock` 驱动让你不装微信也能把全链路跑通。
- **注入**：自带的 Win32 注入器（[native/](native/)）把 hook DLL 送进微信进程，面板一个按钮就能做「注入 → 等 hook 服务 → 开始轮询」。
- **给 agent 一只手**：注册 12 个 `wechat_*` 工具（看消息、分条发、引用、@人、已读水位、轻量记忆、链路自检）。
- **自动回复**：每个微信会话映射成一个独立 DSH 会话，跑 `wechat-agent` 模式（人格 markdown 注入），一轮结束把最终文本**原样**发回微信。
- **两种输出模式**：没调发送工具 → 本轮最终文本原样转发；调了发送工具 → 文本只作思考（agent 自己控制发几条、发什么）。
- **一个统一管理面板**：装好插件，DSH 侧栏多一个「微信桥接」入口，点开就是完整控制台 —— 配网关、跑通链路、看会话、做体检，全程不用开终端。

## 安装

```powershell
# 在 DSH 里（任意会话）让 agent 执行，或等效地用 plugin_manager：
#   plugin_manager({ action: "install_bundle", target: "C:\path\to\dsh-wechat" })
# 它会自己 pnpm 安装、把包写进 profile 的 dsh.profile.bundles、并应用 patch

# 装完重启 DSH，左侧栏就有「微信桥接」入口了
```

也可以用你的终端手动确认两件事：

- `plugin_manager list_plugins` 里 `include:wechat-bridge`、`include:preset-wechat-agent` 都是 `active`；
- 设置 → Agent 预设里出现「微信远程 Agent」卡片。

## 一键面板（推荐，不用终端）

装好插件后重启 DSH，**左侧栏会出现「微信桥接」图标（微信气泡）**，点开就是完整控制台。原来要开终端跑的三个脚本，现在都是页面上的按钮。

### 第一次用：只点三步

概览页中间那张「三步跑通」卡片，按顺序点就行，每一步会自己告诉你好没好：

| 步 | 按钮 | 它做了什么 |
|---|---|---|
| 1 | **启动测试网关** | 在 `[IP]:8787` 起一个只收不发的假网关（不会真的发微信） |
| 2 | **指向测试网关** | 把出站地址写成第 1 步那个地址，改完立即生效 |
| 3 | **发送测试消息** | 让桥接往假网关投一条；下面「最近投递」里出现它，链路就通了 |

三步走完，顶部那条链路图三个节点全绿 —— 这时候接上你自己的微信网关，改一下出站地址，真实消息就能进来了。

### 五个标签页

| 标签 | 干什么 |
|---|---|
| **概览** | 链路健康图 · 收发计数 · 三步向导 · 最近事件与投递 |
| **会话** | 左选会话、右看对话气泡；可提交已读水位 |
| **控制台** | 造入站消息（可勾「唤醒 agent」）· 单发一条出站 · 起停测试网关 · 清空本地缓存 |
| **设置** | 网关类型/凭据、回复行为、人格与档位；改完底部保存条一键写入 |
| **体检** | 7 项自检（相当于 `check.ps1`），每项不合格都直接给修法 |

### 面板改的东西存在哪

`%USERPROFILE%\.dsh\wechat-bridge\config.override.json` —— 只存你改过的键，**不动 profile 的 `cordis.patch.yml`**。设置页底部的「清空覆盖值」可以退回行配置的权威状态。

密钥（`sharedSecret` / `appSecret` / `token`）永远不回传到浏览器：面板只显示「已设置」的布尔位，输入框留空 = 不修改。

## 高级：命令行脚本（可选）

面板覆盖不到的场景才需要它们，都在 `scripts/`，幂等（配置写进 profile patch 的受管区块，重复跑只替换该区块）。

```powershell
# A. 本地跑通整条链路（不连真实微信）：起网关桩 → 推消息 → 等原样投递
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-a-local-gateway.ps1

# B. 只当工具用：关掉自动转发，验证「消息只入库、不自动回」
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-b-tool-only.ps1

# C. 接公众号：切 kind=official，本地验签自测 + （可选）XML 入站自测
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-c-official-account.ps1 `
    -AppId wx1234567890abcdef -AppSecret <secret> -Token <token> `
    -PublicUrl https://bot.example.com/wechat/webhook -TestInbound

# D. 个人微信 hook：起 mock hook 网关 → 造好友消息 → 等 agent 回完发出去
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-d-personal-wechat-hook.ps1

# 体检：语法 + 离线自检 + hook 契约/全链路 + preset 一致性 + 线上状态
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check.ps1
```

场景 A 的正常输出：

```
==> 推入站消息：只回三个字：链路通
  OK  入站已接受：{"ok":true,"accepted":true}
==> 等插件把回复投递到网关桩（最多 150 秒）
  OK  收到 1 条投递

收到的投递（最后一条）：
  2026-10-24T17:00:06.238Z /send {"action":"send","chatId":"wxid_demo","text":"链路通","raw":true}

解析：
  action = send
  chatId = wxid_demo
  raw    = True   （true = 模型最终文本原样发出）
  text   = 链路通

  OK  场景 A 通过：入站 → agent → 原样出站 已闭环
```

> 每个脚本都支持 `-WhatIf`：只打印会写进 profile patch 的配置，不动文件。

## 面板 HTTP API

面板是纯前端 + Host API，两者同一套路由；都是本机回环才允许访问（拒绝带 `x-forwarded-for` 的请求）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/wechat/api/state` | 全量快照：配置（脱敏）、计数、事件、投递、会话 |
| GET | `/wechat/api/chats?chatId=&limit=` | 会话列表 / 某会话消息 |
| POST | `/wechat/api/read` | 提交已读水位 `{chatId, throughSeq?}` |
| GET·PUT | `/wechat/api/config` | 读配置 / 写覆盖值 `{config:{...}}`·`{action:'reset'}` |
| POST | `/wechat/api/console` | `inbound` / `outbound` / `stub-start` / `stub-stop` |
| POST | `/wechat/api/selftest` | 跑 7 项体检 |
| POST | `/wechat/api/reset` | 清空本地缓存 |

`/wechat` 这一段来自 `webhookPath` 去掉尾部的 `/webhook`，改了 `webhookPath` 记得重启。

## 配置

配置写在 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`），或本包自带的 [cordis.patch.yml](cordis.patch.yml) 里。按行 id 覆盖时 **`config` 是整块替换、不深合并**，所以要保留的键都得写出来。

最小配置：

```yaml
- id: wechat-bridge
  name: dsh-wechat-bridge
  config:
    kind: generic
    gateway:
      sendUrl: 'http://127.0.0.1:8787/send'   # 你的网关：插件 POST 回复到这里
      sharedSecret: 'change-me'               # 入站校验（header: X-WeChat-Secret）
    reply:
      autoReply: true
      mode: raw
      agentPreset: wechat-agent
      selfNames: ['小助手']                    # 群里只在这几个名字被 @ 时自动回
      allowedChatIds: []                      # 白名单，留空=不限
    persona:
      file: ./persona/wechat-persona.md
```

全部配置项见 [使用说明书 · 配置手册](使用说明书.md#4-配置手册)。

## 协议（generic）

**入站** `POST /wechat/webhook`（header `X-WeChat-Secret`）：

```json
{ "chatId": "wxid_abc", "chatName": "阿黄", "kind": "private",
  "senderId": "wxid_abc", "senderName": "阿黄", "text": "在吗", "messageId": "m1" }
```

**出站** `POST <gateway.sendUrl>`：

```json
{ "action": "send", "chatId": "wxid_abc", "text": "在的",
  "replyToMessageId": null, "atUserId": null, "raw": true }
```

`200 {"accepted":true}` = 收下并已入库；`202 {"accepted":false}` = 收下但丢弃（白名单外/空文本）；`401` = secret 不对。
本地网关桩：`node scripts/recv.mjs 8787`，收到就写 `.recv.log`。

## agent 模式 wechat-agent

`presets/wechat-agent.patch.yml`（**生成物，勿手改**）：

| 组成 | 作用 |
|---|---|
| `@deepseek-ai/dsh-persona` | `prefix` = [persona/wechat-persona.md](persona/wechat-persona.md) 渲染后的正文 |
| `dsh-tool-web` | 让 agent 能查资料再回 |
| `dsh-tool-todo` / `dsh-tool-ask-user` | 任务清单 / 结构化提问 |
| `dsh-compaction-*`（group+isolate） | 长会话压缩 |

改人格：

```powershell
notepad persona\wechat-persona.md
node scripts\build-preset.mjs          # 重新渲染 preset patch
node scripts\build-preset.mjs --check  # 校验没漂移
```

改完**新建会话**才生效（已有会话保留旧人格）。人格正文里不要出现 `{{…}}`：preset 的 `prefix` 是模板，未知引用会让提示词组装直接抛错。

## 工具面

| 工具 | 作用 |
|---|---|
| `wechat_status` | 网关/计数/未读/人格/最近错误 |
| `wechat_hook` | 个人微信 hook：status / start / stop / poll / reset-cursor / **inject（注入微信）** |
| `wechat_diagnose` | 自检自动回复链路：真建探针会话 + 投递一条，失败直说原因 |
| `wechat_list_chats` | 会话列表（含未读、托管会话 id） |
| `wechat_get_unread_messages` | 读未读（不自动已读） |
| `wechat_get_recent_messages` | 读最近消息（含自己发的） |
| `wechat_send_message` | 发文本；`messages` 数组分多条 |
| `wechat_get_members` | 群成员 |
| `wechat_mark_read` | 提交已读水位 |
| `wechat_memory_append` / `_query` / `_remove` | 轻量记忆：话题 / 想说没说的话 / 成员印象 |
| `wechat_get_prompt` | 当前人格 + 配置摘要 + 工具清单 |

人命令：`/wechat on | off | status | reset`。

## 状态文件

`~/.dsh/wechat-bridge/state.json`：会话、消息（每会话上限 `history.maxMessages`）、记忆、微信会话 → DSH 会话映射、最近一次错误。`/wechat reset` 清空本地缓存（不动真实微信、不删已有 DSH 会话）。

## 已验证 / 未验证

在本机（DSH Desktop，Windows）实测通过：

- 插件激活，12 个 `wechat_*` 工具对 agent 可见；
- `POST /wechat/webhook`（含 secret 校验、401/202 分支）入站入库；
- 按会话创建 `agentPreset: wechat-agent` 的 DSH 会话，模型跑到 `turn/end`；
- 最终文本以 `raw:true` **原样**投递到网关桩（`text` 一个字没改）；
- 改配置后热点重载生效（autoReply 开关、kind 切换）；
- 公众号签名验签（GET echostr 原文返回、错误签名 403）+ XML 入站解析；
- 个人微信 hook 全链路（真 HTTP、真网关）：`/mock/push` → 轮询拉取入库 → agent → `POST /send` → `/mock/out` 读回原文；含 401、去重、`selfIds` 过滤、游标增量；
- 注入器自测（native/test-inject.ps1）：64 位注入成功、靶子进程里出现 marker 文件、进程不存在时返回 `process-not-found`；
- 插件的注入编排：`node scripts/test-inject.mjs` 拿**真实注入器**打进一个真实靶子进程，DLL 的 marker 文件出现、pid 回读、进程不存在时给 `process-not-found`；
- selftest 里的注入分支：注入器输出解析、缺注入器 / 缺 DLL 的可操作报错；
- hook 在**运行中的 DSH 里**跑通（v0.3.0）：`scenario-d` 一键脚本实测 agent 回复「在，说。」经网关 `/send` 收到；面板 `/api/console` 的 `hook-poll / hook-stop / hook-start / hook-reset-cursor` 与 `wechat_hook` 工具均按预期工作。

**未验证**：真实微信侧网关（WeChatFerry / Gewechat / 公众号后台）。插件只约定协议，不含任何 hook 实现。

## 目录

```
dsh-wechat/
├─ index.js                      插件本体（网关 / 工具 / 自动回复 / 人格）
├─ client.js                     浏览器端统一管理面板（React，无需构建）
├─ lib/panel.js                  面板 Host API（快照 / 配置 / 控制台 / 自检 / 网关桩）
├─ cordis.patch.yml              插件行 + 全量配置骨架
├─ presets/wechat-agent.patch.yml agent 模式（生成物）
├─ persona/wechat-persona.md     人格正文（唯一权威源）
├─ native/
│  ├─ wechat-inject.c           Win32 DLL 注入器（--process/--pid + --dll，输出 JSON）
│  ├─ test-payload.c            自测用 DLL（往 %TEMP% 写一行证明注入成功）
│  ├─ test-target.c             自测靶子进程
│  ├─ build.ps1                 用 MinGW gcc 编译三个产物
│  ├─ test-inject.ps1           注入自测（成功路径 + 进程不存在）
│  └─ README.md                 用法与微信接入说明
├─ gateway/
│  ├─ hook-gateway.mjs           个人微信 hook 适配网关（mock / wcf / exec 驱动）
│  └─ README.md                  协议、驱动、字段映射
├─ scripts/
│  ├─ build-preset.mjs           md → preset patch
│  ├─ selftest.mjs               离线自检（假 ctx + harness 真校验器）
│  ├─ verify-client.mjs          面板 SSR 冒烟测试（不需要浏览器）
│  ├─ verify-client-states.mjs   词典完整性 + 异常快照渲染测试
│  ├─ fixtures/snapshot.json     面板测试用的快照样本
│  ├─ recv.mjs                   本地网关桩（独立进程版）
│  ├─ peek.mjs                   会话日志（多帧 zstd）读取器
│  ├─ check.ps1                  命令行体检
│  ├─ scenario-a-local-gateway.ps1
│  ├─ scenario-b-tool-only.ps1
│  └─ scenario-c-official-account.ps1
├─ locale/{zh,en}.json、icon.svg  插件管理器展示元数据
├─ 使用说明书.md                  完整手册（配置全表 / 网关对接 / 排障 / FAQ）
└─ LICENSE
```

## 限制

- 个人微信没有公开 API：需要一个本机 hook 服务（WeChatFerry / 自建）。本仓库提供的是**适配网关**（`gateway/`），不包含任何注入/hook 客户端本身。
- 公众号客服消息有 48 小时窗口（`errcode 45015`），长期主动推送需要模板/订阅消息。
- webhook 路由挂在 DSH 自己的监听上，没有额外鉴权；要公网访问请自建反代 + TLS，只放行 `/wechat/webhook*`。
- 注入要自己准备**与微信版本匹配**的 hook DLL；本仓库不含任何 WeChat hook DLL，也不含绕过/反检测之类的东西。
- agent 模式不是安全沙箱：preset 里挂的插件可以执行 Host 代码。

## License

MIT
