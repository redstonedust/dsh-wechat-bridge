# gateway —— 个人微信 hook 适配网关

个人微信没有公开 API。插件不能直接连微信，只能连一个**本机 hook 服务**。这个目录就是那个服务的参考实现：把各种 hook 的差异收敛成插件认的两个端点。

```
微信客户端 ──(注入/hook)──▶ hook 服务 ──(HTTP 轮询)──▶ dsh-wechat-bridge ──▶ DSH agent
                                  ▲                              │
                                  └────────(POST /send)──────────┘
```

## 端点契约

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | `{"ok":true,"driver":"mock"}` |
| `GET` | `/messages?cursor=&limit=` | `{"ok":true,"cursor":"…","messages":[{id,chatId,kind,senderId,senderName,text,time}]}` |
| `POST` | `/send` | `{"chatId":"…","text":"…"}` → `{"ok":true,"id":"…"}` |
| `POST` | `/mock/push` | 仅 mock：造一条入站（联调用） |
| `GET` | `/mock/out` | 仅 mock：看插件发出来的消息 |

配置了 `--secret` 时，`/messages` 与 `/send` 必须带 `X-WeChat-Secret`。监听地址默认 `127.0.0.1`。

`cursor` 是你自己定义的增量游标（序号、时间戳、uuid 都行），插件只负责原样回传；首次拉取不带 cursor 时应返回「从现在开始」而不是全量历史。

## 驱动

### mock（默认）

不碰微信，用来把「微信 → agent → 微信」整条链路跑通、以及做 CI。

```powershell
node gateway/hook-gateway.mjs --driver mock --port 8788 --secret change-me
# 另开一个窗口：造一条好友消息
curl -X POST http://127.0.0.1:8788/mock/push -H "content-type: application/json" `
     -d '{"chatId":"wxid_demo","senderName":"好友","text":"在吗"}'
# 看 agent 回了什么
curl http://127.0.0.1:8788/mock/out
```

### wcf（WeChatFerry 的 HTTP 封装）

```powershell
node gateway/hook-gateway.mjs --driver wcf --port 8788 --secret change-me `
     --wcf-base http://127.0.0.1:9999
```

默认假定 wcf-http 是 `POST <base>/<method>` + `{"args":[…]}`，方法名 `get_msg` / `send_text`。
不同实现的路径和参数形态差别很大，用这些参数适配，**不用改代码**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--wcf-base` | `http://127.0.0.1:9999` | hook 服务基地址 |
| `--get-path` / `--send-path` | `/{method}` | 路径模板，`{method}` 会被替换 |
| `--get-method` / `--send-method` | `get_msg` / `send_text` | 方法名 |
| `--arg-style args\|params` | `args` | body 是 `{"args":[…]}` 还是 `{"params":{…}}` |

字段映射（`get_msg` 返回值）默认按 WeChatFerry 的常见形状取：`id`、`roomid`（群）、`sender`（发言人）、`content`、`ts`。
如果你的实现字段不同，改 `createWcfDriver()` 里那段 `fresh.push({...})` 即可——只有十几行。

### exec（把任何本地脚本包一层）

最通用的逃生口：你的 hook 工具只要能「读消息 / 发消息」，用命令行包起来就行。

```powershell
node gateway/hook-gateway.mjs --driver exec --port 8788 --secret change-me `
  --get-cmd  "python C:\my-hook\bridge.py pull {{cursor}} {{limit}}" `
  --send-cmd "python C:\my-hook\bridge.py send {{chatId}} {{text}}"
```

- `--get-cmd` 的 stdout 必须是 JSON：`{"cursor":"…","messages":[…]}` 或直接一个消息数组。
- `--send-cmd` 的 stdout 随意，取前 200 字符当回执 id。
- `{{cursor}}` `{{limit}}` `{{chatId}}` `{{text}}` 会被替换，值已做引号转义。

## 插件侧配置

```yaml
- id: wechat-bridge
  name: dsh-wechat-bridge
  config:
    kind: hook
    hook:
      baseUrl: 'http://127.0.0.1:8788'
      secret: 'change-me'
      pollMs: 3000
      selfIds: ['wxid_bot']   # 机器人自己的 wxid，防自问自答
```

面板「控制台 → 个人微信 Hook」里可以看到游标、已收条数、最近错误，并能随时 开始/停止轮询、立即拉一次、游标归零。

## 自测

```powershell
node scripts/test-hook-gateway.mjs      # 契约：health / 游标增量 / 401 / 400 / 404
node scripts/test-hook-integration.mjs  # 真 HTTP 全链路：push → 轮询 → agent → /send → /mock/out
```

两个都不需要微信，也不需要 DSH 进程。
