# 面板测试用的样本与工具

| 文件 | 说明 |
|---|---|
| `snapshot.json` | 一份真实的 `GET /wechat/api/state` 响应，`verify-client.mjs` 用它渲染每个标签页 |
| `measure.js` | 浏览器端布局度量函数（横向溢出 / 文字截断 / 字号下限 / 对比度），配合 `playwright-cli eval` 用 |
| `extract-css.mjs` | 把 `client.js` 里的 CSS 模板取出来，供 `css-audit.mjs` 审 |
| `css-audit.mjs` | 动效规范审计：`transition: all`、`scale(0)`、超长时长、reduced-motion 兜底 |

刷新 `snapshot.json`（DSH 在跑的时候）：

```bash
curl -sS http://127.0.0.1:43120/wechat/api/state -o scripts/fixtures/snapshot.json
```
