/**
 * dsh-wechat-bridge · 浏览器端（统一管理前端）。
 *
 * 目标：装好插件 → 侧栏出现「微信桥接」→ 点一下就有完整控制台。
 * 原来要靠 scripts/*.ps1 在终端里演的三个剧本，现在都是这个页面上的按钮：
 *   体检（原 check.ps1）· 网关桩 + 入站/出站自测（原 scenario-a）
 *   开关自动回复、切网关类型、填凭据（原 scenario-b / c）
 *
 * 约束（DSH 客户端插件规范）：
 *   - 纯浏览器 ESM，走 module loader 格式，不需要构建；只 require('react')。
 *   - 样式一次性注入单个 <style>，颜色/字体只取 --dsw-alias-* 与 --dsw-font-family，
 *     深浅主题自动跟随。
 *   - factory 无副作用；注册、词典、定时器全在 apply 里用 ctx.effect 挂并返回清理器。
 *   - 所有可见文案走 Client locale 服务（zh/en 双份）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ═════════════════════════════ 常量 ═════════════════════════════ */

    const NS = 'wechat';
    const STYLE_ID = 'dsh-wechat-bridge-style';
    /** 文档相对：页面可能挂在子路径下，所以去掉前缀斜杠（与 task-board 同规则）。 */
    const API_PREFIX = 'wechat/api';
    const ROUTES = {
      state: API_PREFIX + '/state',
      chats: API_PREFIX + '/chats',
      read: API_PREFIX + '/read',
      config: API_PREFIX + '/config',
      console: API_PREFIX + '/console',
      selftest: API_PREFIX + '/selftest',
      reset: API_PREFIX + '/reset',
    };
    const POLL_MS = 2500;
    const ACTION_TIMEOUT_MS = 20000;
    const MAX_EVENTS = 40;
    const STUB_PORT_FALLBACK = 8787;
    const TABS = [
      { id: 'overview', label: 'tabs.overview', icon: 'grid' },
      { id: 'chats', label: 'tabs.chats', icon: 'chat' },
      { id: 'console', label: 'tabs.console', icon: 'terminal' },
      { id: 'settings', label: 'tabs.settings', icon: 'sliders' },
      { id: 'check', label: 'tabs.check', icon: 'check' },
    ];
    const WIZARD_STEPS = ['stub', 'point', 'ping'];
    const MONO_FONT = 'ui-monospace, SFMono-Regular, SFMono, Menlo, Consolas, "Courier New", monospace';
    /** 动效曲线：强 ease-out（进场/反馈）、强 ease-in-out（位移）。 */
    const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
    const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';

    /* ═════════════════════════════ 词典 ═════════════════════════════ */

    const ZH = {
      'entry.label': '微信桥接',

      'panel.title': '微信桥接',
      'panel.subtitle': '一条链路把微信接到 DSH：网关收消息，agent 想回复，桥接发回去。',
      'panel.badge.on': '运行中',
      'panel.badge.off': '已关闭',
      'panel.badge.missing': '未挂载',
      'panel.refresh': '刷新',
      'panel.updated': '{time} 更新',
      'panel.stale': '显示的是 {time} 的快照',

      'health.wechat': '微信侧',
      'health.bridge': '桥接',
      'health.agent': 'DSH Agent',
      'health.wechat.on': '网关已就绪',
      'health.wechat.off': '还没配出站地址',
      'health.bridge.on': 'webhook 在听',
      'health.agent.on': '预设已加载',
      'health.agent.off': '找不到预设',
      'health.agent.noService': 'agent 服务缺席',
      'health.wechat.failed': '上次投递失败',
      'health.wechat.unverified': '地址已填，尚未验证',
      'health.bridge.listening': '{path} 在听',
      'health.agent.unset': '还没选预设',
      'health.hint': '三个节点都亮起，微信里发一句话就会有人回。',
      'health.hint.off': '还有节点没亮：灰色的那一步配好之后，链路就通了。',
      'health.hint.warn': '配置齐了，但出站这条路还没验证过。跑一遍下面的三步跑通就能确认。',

      'tabs.overview': '总览',
      'tabs.chats': '会话',
      'tabs.console': '控制台',
      'tabs.settings': '设置',
      'tabs.check': '体检',

      'stat.inbound': '收到的消息',
      'stat.outbound': '发出的消息',
      'stat.replies': '自动回复',
      'stat.errors': '出错次数',
      'stat.chats': '会话数',
      'stat.sessions': '活跃 Agent',
      'stat.unit': '条',
      'stat.uptime': '已运行 {duration}',

      'wizard.title': '三步跑通',
      'wizard.subtitle': '不用开终端，也不用记命令。按顺序点，中途每一步都会自己告诉你成没成。',
      'wizard.progress': '第 {done} / {total} 步',
      'wizard.done': '链路已打通',
      'wizard.doneHint': '刚才那条测试消息已经走完「桥接 → 网关」全程。现在把真实网关地址填进设置就正式可用。',
      'wizard.reset': '重新走一遍',
      'wizard.stub.title': '起一个本地测试网关',
      'wizard.stub.desc': '在 127.0.0.1:8787 开一个只收不发的假网关，用来验证「发出去」这条路是通的。不会真的发微信。',
      'wizard.stub.action': '启动测试网关',
      'wizard.stub.running': '正在启动…',
      'wizard.stub.done': '测试网关已就绪',
      'wizard.point.title': '让插件指向它',
      'wizard.point.desc': '把出站地址改成测试网关。改完立即生效，不用重启。',
      'wizard.point.action': '指向测试网关',
      'wizard.point.running': '正在写入…',
      'wizard.point.done': '出站已指向 {url}',
      'wizard.point.needStub': '先做第 1 步',
      'wizard.ping.title': '发一条测试消息',
      'wizard.ping.desc': '让桥接往测试网关投一条消息。下面「最近投递」里出现它，就说明整条链路通了。',
      'wizard.ping.action': '发送测试消息',
      'wizard.ping.running': '正在发送…',
      'wizard.ping.done': '已投递，去下面看回执',
      'wizard.ping.text': '这是一条来自 DSH 微信桥接的测试消息 👋',
      'wizard.stop': '关掉测试网关',
      'wizard.stop.done': '测试网关已关闭',

      'events.title': '最近发生了什么',
      'events.empty': '还没有事件。点上面的「三步跑通」，这里会实时滚出每一步。',
      'events.note': '只保留最近 {count} 条。',
      'deliveries.title': '最近投递',
      'deliveries.empty': '还没有投递记录。',
      'deliveries.phase.stub': '测试网关收到',
      'deliveries.phase.manual': '手动测试',
      'deliveries.phase.reply': '自动回复',
      'deliveries.ok': '成功',
      'deliveries.fail': '失败',

      'chats.title': '会话',
      'chats.subtitle': '每个微信会话对应一个独立的 DSH Agent。',
      'chats.empty': '还没有会话。等微信那边发来第一条消息，或者去控制台手动造一条。',
      'chats.unread': '{count} 条未读',
      'chats.messages': '{count} 条消息',
      'chats.pick': '左边选一个会话看对话。',
      'chats.markRead': '标记已读',
      'chats.markReadDone': '已标记到第 {seq} 条',
      'chats.threadEmpty': '这个会话还没有消息。',
      'chats.loading': '正在读取…',
      'chats.dir.in': '收',
      'chats.dir.out': '发',

      'console.title': '控制台',
      'console.subtitle': '不发真实微信，也能把桥接的每条链路单独按一遍。',
      'console.inbound.title': '模拟一条入站消息',
      'console.inbound.desc': '相当于微信里有人说了句话。默认只落库不唤醒 agent；勾上「唤醒」就走完整自动回复。',
      'console.inbound.chatId': '会话 ID',
      'console.inbound.chatIdHint': '随便起个名字都行，比如 test-user 或 123456@chatroom。',
      'console.inbound.text': '消息内容',
      'console.inbound.wake': '唤醒 agent 并自动回复',
      'console.inbound.wakeHint': '代价是真的会建一个 DSH 会话，跑完把回复投递出去。',
      'console.inbound.submit': '送入',
      'console.inbound.sending': '正在送入…',
      'console.inbound.ok': '已送入（seq {seq}）',
      'console.inbound.okWake': '已送入并唤醒 agent',
      'console.outbound.title': '测试一次出站投递',
      'console.outbound.desc': '绕过 agent，直接把一段文字交给网关。用来单独验证「发得出去」。',
      'console.outbound.text': '要发的内容',
      'console.outbound.submit': '投递',
      'console.outbound.sending': '正在投递…',
      'console.outbound.ok': '投递成功',
      'console.stub.title': '本地测试网关',
      'console.stub.desc': '一个只听不做的 HTTP 桩，收到的内容会原样出现在「最近投递」里。',
      'console.stub.port': '端口',
      'console.stub.on': '运行中 · 127.0.0.1:{port}',
      'console.stub.off': '未启动',
      'console.stub.start': '启动',
      'console.stub.stop': '停止',
      'console.stub.addr': '投递地址',
      'console.reset.title': '清空本地缓存',
      'console.reset.desc': '只清这个插件自己攒的会话与消息记录，不动真实微信会话，也不删 DSH 会话。',
      'console.reset.action': '清空',
      'console.reset.confirm': '确认清空？这一步不可撤销。',
      'console.reset.done': '已清空 {count} 个会话',

      'settings.title': '设置',
      'settings.subtitle': '改动立即生效并写进插件覆盖值，重启后依然有效。',
      'settings.group.reply': '自动回复',
      'settings.group.gateway': '网关',
      'settings.group.scope': '范围与人格',
      'settings.save': '保存改动',
      'settings.saving': '正在保存…',
      'settings.saved': '已保存 {count} 项，立即生效',
      'settings.savedRestart': '已保存。其中 {count} 项要重载插件才完全生效。',
      'settings.dirty': '{count} 项未保存',
      'settings.clean': '没有改动',
      'settings.discard': '放弃改动',
      'settings.reload': '需要重载',
      'settings.reloadHint': '这项绑在路由上，保存后要重启 DSH 或重载插件。',
      'settings.override': '当前有 {count} 个面板覆盖值',
      'settings.overrideNone': '当前没有面板覆盖值，用的是插件行配置',
      'settings.resetOverride': '清空覆盖值',
      'settings.resetOverrideDone': '覆盖值已清空，重载后回到行配置',

      'field.autoReply': '自动回复',
      'field.autoReplyHint': '关掉之后消息照收、工具照用，但不自动回话。',
      'field.mode': '回复格式',
      'field.mode.raw': '原样',
      'field.mode.formatted': '加前后缀',
      'field.modeHint': '「加前后缀」适合给回复套一句话头，比如「【DSH】」。',
      'field.prefix': '前缀',
      'field.suffix': '后缀',
      'field.prefixHint': '只在「加前后缀」模式下生效。',
      'field.maxReplyChars': '单条上限（字符）',
      'field.maxReplyCharsHint': '超长会被截断，微信侧对长度有限制。',
      'field.fallbackText': '失败兜底话术',
      'field.fallbackTextHint': 'agent 报错时回这一句，留空就什么都不发。',
      'field.idleSessionMs': '会话空闲回收（毫秒）',
      'field.idleSessionMsHint': '这么久没说话就释放对应的 DSH 会话。1800000 是 30 分钟。',
      'field.agentPreset': '自动回复用的预设',
      'field.agentPresetHint': '每个微信会话会按这个预设起一个 agent。',
      'field.fallbackPreset': '备用预设',
      'field.fallbackPresetHint': '主预设不可用时改用它，可留空。',
      'field.kind': '网关类型',
      'field.kind.generic': '自建网关（通用 HTTP）',
      'field.kind.official': '微信公众号',
      'field.kind.wecom': '企业微信群机器人',
      'field.kindHint': '选哪种取决于你手上是什么。自建网关最常见。',
      'field.sendUrl': '出站地址',
      'field.sendUrlHint': '桥接把回复 POST 到这里。自建网关必填。',
      'field.sharedSecret': '共享密钥',
      'field.sharedSecretHint': '填了就带在 x-wechat-secret 头上，网关自己校验。',
      'field.appId': 'AppID',
      'field.appSecret': 'AppSecret',
      'field.token': '服务器 Token',
      'field.officialHint': '公众号在「设置与开发 → 基本配置」里能拿到这三个值。',
      'field.wecomWebhook': '群机器人 webhook',
      'field.wecomHint': '企业微信群里「添加机器人」拿到的地址。',
      'field.allowedChatIds': '只处理这些会话',
      'field.allowedChatIdsHint': '一行一个，或用逗号/空格分隔。留空表示全部都接。',
      'field.selfNames': '自己的别名',
      'field.selfNamesHint': '群里出现这些名字时，当作是在叫我。',
      'field.debug': '调试日志',
      'field.debugHint': '把每一步都写进 DSH 日志，排障时开。',
      'field.webhookPath': '入站路径',
      'field.webhookPathHint': '微信侧要配成「你的地址」+ 这个路径。',
      'field.set': '已设置',
      'field.notSet': '未设置',
      'field.secretPlaceholder': '已设置，留空则不修改',
      'field.secretEmpty': '未设置，输入以启用',

      'check.title': '体检',
      'check.subtitle': '一次跑完 7 项，把最常见的问题直接指出来，并告诉你下一步点哪。',
      'check.run': '开始体检',
      'check.running': '正在检查…',
      'check.summary': '{passed} / {total} 通过',
      'check.summaryFail': '{failed} 项需要处理',
      'check.allOk': '全部通过',
      'check.empty': '还没体检。点上面按钮，几秒钟出结果。',
      'check.fix': '怎么办：{fix}',
      'check.ranAt': '{time} 跑的',
      'check.level.ok': '通过',
      'check.level.warn': '注意',
      'check.level.error': '有问题',

      'host.loading': '正在连上 Host…',
      'host.missingTitle': 'Host 半边没挂上',
      'host.missingBody': '没找到 wechat/api/state 这个路由。确认插件在 profile 里是启用状态，然后重载插件或重启 DSH。页面会自己重试。',
      'host.errorTitle': '读不到状态',
      'host.unreachable': '连不上 Host 服务。',
      'host.badPayload': 'Host 返回了读不懂的数据。',
      'host.httpError': '状态请求失败（HTTP {status}）。',
      'host.retry': '重试',

      'common.copy': '复制',
      'common.copied': '已复制',
      'common.none': '无',
      'common.dash': '—',
      'common.justNow': '刚刚',
      'common.minutesAgo': '{count} 分钟前',
      'common.hoursAgo': '{count} 小时前',
      'common.daysAgo': '{count} 天前',
      'action.failed': '操作失败（{code}）。',
      'action.httpError': '请求失败（HTTP {status}）。',
      'action.timeout': '请求超时了。',
      'action.unreachable': '连不上 Host 服务。',
    };

    const EN = {
      'entry.label': 'WeChat Bridge',

      'panel.title': 'WeChat Bridge',
      'panel.subtitle': 'One path from WeChat into DSH: the gateway receives, the agent thinks, the bridge replies.',
      'panel.badge.on': 'Live',
      'panel.badge.off': 'Off',
      'panel.badge.missing': 'Not mounted',
      'panel.refresh': 'Refresh',
      'panel.updated': 'Updated {time}',
      'panel.stale': 'Showing the snapshot from {time}',

      'health.wechat': 'WeChat side',
      'health.bridge': 'Bridge',
      'health.agent': 'DSH agent',
      'health.wechat.on': 'Gateway configured',
      'health.wechat.off': 'No outbound URL yet',
      'health.bridge.on': 'Webhook listening',
      'health.agent.on': 'Preset loaded',
      'health.agent.off': 'Preset missing',
      'health.agent.noService': 'Agent services absent',
      'health.wechat.failed': 'Last delivery failed',
      'health.wechat.unverified': 'URL set, not verified',
      'health.bridge.listening': 'Listening on {path}',
      'health.agent.unset': 'No preset chosen',
      'health.hint': 'When all three light up, a message in WeChat gets an answer.',
      'health.hint.off': 'Still dark: finish the greyed-out step and the chain is complete.',
      'health.hint.warn': 'Everything is configured, but the outbound path has not been proven yet. Run the three steps below.',

      'tabs.overview': 'Overview',
      'tabs.chats': 'Chats',
      'tabs.console': 'Console',
      'tabs.settings': 'Settings',
      'tabs.check': 'Health',

      'stat.inbound': 'Messages in',
      'stat.outbound': 'Messages out',
      'stat.replies': 'Auto replies',
      'stat.errors': 'Errors',
      'stat.chats': 'Chats',
      'stat.sessions': 'Live agents',
      'stat.unit': '',
      'stat.uptime': 'Up {duration}',

      'wizard.title': 'Running in three steps',
      'wizard.subtitle': 'No terminal, no commands to memorise. Press them in order; each step reports whether it worked.',
      'wizard.progress': 'Step {done} of {total}',
      'wizard.done': 'End to end, working',
      'wizard.doneHint': 'That test message travelled the whole bridge → gateway path. Point the outbound URL at your real gateway and it is in service.',
      'wizard.reset': 'Run it again',
      'wizard.stub.title': 'Start a local test gateway',
      'wizard.stub.desc': 'Opens a receive-only stub on 127.0.0.1:8787 so you can prove the outbound path works. Nothing is sent to WeChat.',
      'wizard.stub.action': 'Start test gateway',
      'wizard.stub.running': 'Starting…',
      'wizard.stub.done': 'Test gateway ready',
      'wizard.point.title': 'Point the plugin at it',
      'wizard.point.desc': 'Rewrites the outbound URL to the stub. Takes effect immediately, no restart.',
      'wizard.point.action': 'Point at it',
      'wizard.point.running': 'Writing…',
      'wizard.point.done': 'Outbound now posts to {url}',
      'wizard.point.needStub': 'Do step 1 first',
      'wizard.ping.title': 'Send a test message',
      'wizard.ping.desc': 'The bridge posts one message to the stub. If it shows up under “Recent deliveries”, the path is whole.',
      'wizard.ping.action': 'Send test message',
      'wizard.ping.running': 'Sending…',
      'wizard.ping.done': 'Delivered — see the receipt below',
      'wizard.ping.text': 'A test message from the DSH WeChat bridge 👋',
      'wizard.stop': 'Stop the test gateway',
      'wizard.stop.done': 'Test gateway stopped',

      'events.title': 'What just happened',
      'events.empty': 'No events yet. Run “Running in three steps” above and they scroll in here.',
      'events.note': 'Latest {count} kept.',
      'deliveries.title': 'Recent deliveries',
      'deliveries.empty': 'No deliveries yet.',
      'deliveries.phase.stub': 'Stub received',
      'deliveries.phase.manual': 'Manual test',
      'deliveries.phase.reply': 'Auto reply',
      'deliveries.ok': 'OK',
      'deliveries.fail': 'Failed',

      'chats.title': 'Chats',
      'chats.subtitle': 'Every WeChat chat maps to its own DSH agent.',
      'chats.empty': 'No chats yet. Wait for the first message from WeChat, or forge one in the Console.',
      'chats.unread': '{count} unread',
      'chats.messages': '{count} messages',
      'chats.pick': 'Pick a chat on the left to read it.',
      'chats.markRead': 'Mark read',
      'chats.markReadDone': 'Marked through #{seq}',
      'chats.threadEmpty': 'No messages in this chat yet.',
      'chats.loading': 'Loading…',
      'chats.dir.in': 'IN',
      'chats.dir.out': 'OUT',

      'console.title': 'Console',
      'console.subtitle': 'Exercise each leg of the bridge on its own, without touching real WeChat.',
      'console.inbound.title': 'Simulate an inbound message',
      'console.inbound.desc': 'As if someone spoke in WeChat. By default it only stores the message; tick “wake” to run the full auto-reply.',
      'console.inbound.chatId': 'Chat id',
      'console.inbound.chatIdHint': 'Any name works, e.g. test-user or 123456@chatroom.',
      'console.inbound.text': 'Message text',
      'console.inbound.wake': 'Wake the agent and auto-reply',
      'console.inbound.wakeHint': 'This really opens a DSH session and delivers whatever it answers.',
      'console.inbound.submit': 'Deliver',
      'console.inbound.sending': 'Delivering…',
      'console.inbound.ok': 'Stored (seq {seq})',
      'console.inbound.okWake': 'Stored and the agent was woken',
      'console.outbound.title': 'Test one outbound delivery',
      'console.outbound.desc': 'Skips the agent and hands text straight to the gateway. Proves “send” on its own.',
      'console.outbound.text': 'Text to send',
      'console.outbound.submit': 'Send',
      'console.outbound.sending': 'Sending…',
      'console.outbound.ok': 'Delivered',
      'console.stub.title': 'Local test gateway',
      'console.stub.desc': 'A receive-only HTTP stub. Whatever it gets appears verbatim under “Recent deliveries”.',
      'console.stub.port': 'Port',
      'console.stub.on': 'Running · 127.0.0.1:{port}',
      'console.stub.off': 'Not started',
      'console.stub.start': 'Start',
      'console.stub.stop': 'Stop',
      'console.stub.addr': 'Delivery URL',
      'console.reset.title': 'Clear local cache',
      'console.reset.desc': 'Clears only this plugin’s own chat and message records. Real WeChat chats and DSH sessions are untouched.',
      'console.reset.action': 'Clear',
      'console.reset.confirm': 'Clear now? This cannot be undone.',
      'console.reset.done': 'Cleared {count} chats',

      'settings.title': 'Settings',
      'settings.subtitle': 'Changes apply immediately and persist as plugin overrides, including across restarts.',
      'settings.group.reply': 'Auto reply',
      'settings.group.gateway': 'Gateway',
      'settings.group.scope': 'Scope and persona',
      'settings.save': 'Save changes',
      'settings.saving': 'Saving…',
      'settings.saved': 'Saved {count} field(s), live now',
      'settings.savedRestart': 'Saved. {count} field(s) need a plugin reload to fully apply.',
      'settings.dirty': '{count} unsaved',
      'settings.clean': 'No changes',
      'settings.discard': 'Discard',
      'settings.reload': 'Needs reload',
      'settings.reloadHint': 'This one is bound to a route; restart DSH or reload the plugin after saving.',
      'settings.override': '{count} panel override(s) active',
      'settings.overrideNone': 'No panel overrides; the plugin row config is authoritative',
      'settings.resetOverride': 'Clear overrides',
      'settings.resetOverrideDone': 'Overrides cleared; the row config applies after reload',

      'field.autoReply': 'Auto reply',
      'field.autoReplyHint': 'When off, messages are still received and tools still work — it just does not answer.',
      'field.mode': 'Reply format',
      'field.mode.raw': 'As-is',
      'field.mode.formatted': 'With prefix/suffix',
      'field.modeHint': '“With prefix/suffix” wraps each reply, e.g. with 【DSH】.',
      'field.prefix': 'Prefix',
      'field.suffix': 'Suffix',
      'field.prefixHint': 'Only used in the prefix/suffix format.',
      'field.maxReplyChars': 'Max length (chars)',
      'field.maxReplyCharsHint': 'Longer replies get cut; WeChat limits message length.',
      'field.fallbackText': 'Fallback line',
      'field.fallbackTextHint': 'Sent when the agent errors out. Empty sends nothing.',
      'field.idleSessionMs': 'Idle session timeout (ms)',
      'field.idleSessionMsHint': 'Releases the DSH session after this much silence. 1800000 is 30 minutes.',
      'field.agentPreset': 'Preset for auto reply',
      'field.agentPresetHint': 'Each WeChat chat starts an agent from this preset.',
      'field.fallbackPreset': 'Fallback preset',
      'field.fallbackPresetHint': 'Used when the main preset is unavailable; may be empty.',
      'field.kind': 'Gateway type',
      'field.kind.generic': 'Self-hosted gateway (plain HTTP)',
      'field.kind.official': 'WeChat Official Account',
      'field.kind.wecom': 'WeCom group bot',
      'field.kindHint': 'Pick whichever you actually have. Self-hosted is the common case.',
      'field.sendUrl': 'Outbound URL',
      'field.sendUrlHint': 'The bridge POSTs replies here. Required for a self-hosted gateway.',
      'field.sharedSecret': 'Shared secret',
      'field.sharedSecretHint': 'If set, sent as x-wechat-secret for your gateway to check.',
      'field.appId': 'AppID',
      'field.appSecret': 'AppSecret',
      'field.token': 'Server token',
      'field.officialHint': 'All three live under Settings → Basic configuration in the Official Account console.',
      'field.wecomWebhook': 'Group bot webhook',
      'field.wecomHint': 'The URL you get from “Add bot” in a WeCom group.',
      'field.allowedChatIds': 'Only these chats',
      'field.allowedChatIdsHint': 'One per line, or separated by commas/spaces. Empty accepts every chat.',
      'field.selfNames': 'My aliases',
      'field.selfNamesHint': 'When these names appear in a group, treat it as addressed to me.',
      'field.debug': 'Debug logging',
      'field.debugHint': 'Writes every step to the DSH log; turn on while troubleshooting.',
      'field.webhookPath': 'Inbound path',
      'field.webhookPathHint': 'Configure WeChat with your base URL plus this path.',
      'field.set': 'Set',
      'field.notSet': 'Not set',
      'field.secretPlaceholder': 'Already set — leave blank to keep it',
      'field.secretEmpty': 'Not set — type to enable',

      'check.title': 'Health check',
      'check.subtitle': 'Seven checks in one pass, naming the usual suspects and telling you which control to press next.',
      'check.run': 'Run health check',
      'check.running': 'Checking…',
      'check.summary': '{passed} of {total} passed',
      'check.summaryFail': '{failed} need attention',
      'check.allOk': 'All clear',
      'check.empty': 'Not run yet. Press the button; results take a few seconds.',
      'check.fix': 'Fix: {fix}',
      'check.ranAt': 'Ran at {time}',
      'check.level.ok': 'Pass',
      'check.level.warn': 'Warn',
      'check.level.error': 'Problem',

      'host.loading': 'Connecting to the host…',
      'host.missingTitle': 'Host half not mounted',
      'host.missingBody': 'The wechat/api/state route was not found. Confirm the plugin is enabled in your profile, then reload the plugin or restart DSH. This page keeps retrying on its own.',
      'host.errorTitle': 'Cannot read state',
      'host.unreachable': 'Cannot reach the host service.',
      'host.badPayload': 'The host returned unreadable state.',
      'host.httpError': 'State request failed (HTTP {status}).',
      'host.retry': 'Retry',

      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.none': 'None',
      'common.dash': '—',
      'common.justNow': 'just now',
      'common.minutesAgo': '{count}m ago',
      'common.hoursAgo': '{count}h ago',
      'common.daysAgo': '{count}d ago',
      'action.failed': 'Request failed ({code}).',
      'action.httpError': 'Request failed (HTTP {status}).',
      'action.timeout': 'The request timed out.',
      'action.unreachable': 'Cannot reach the host service.',
    };

    /** 模块级翻译指针，apply 时绑定到 locale 服务。 */
    let translate = function identity(key) { return key; };
    let subscribeLocale = null;

    function T(key, params) {
      let text;
      try {
        text = translate(key);
      } catch (error) {
        text = key;
      }
      if (typeof text !== 'string' || text === '' || text === key) text = key;
      if (!params) return text;
      return text.replace(/\{(\w+)\}/g, function replace(match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
          ? String(params[name])
          : match;
      });
    }

    /* ═════════════════════════════ 样式 ═════════════════════════════ */

    const CSS = `
.wx-page {
  --wx-ease-out: ${EASE_OUT};
  --wx-ease-in-out: ${EASE_IN_OUT};
  --wx-mono: ${MONO_FONT};
  display: flex;
  flex-direction: column;
  gap: 18px;
  box-sizing: border-box;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: 22px 24px 56px;
  overflow-y: auto;
  overflow-x: hidden;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 1.55;
  scrollbar-width: thin;
}
.wx-page *, .wx-page *::before, .wx-page *::after { box-sizing: border-box; }

/* ── 通用表面 ── */
.wx-card {
  position: relative;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  padding: 16px 18px;
  min-width: 0;
}
.wx-card--flush { padding: 0; overflow: hidden; }
.wx-card--accent { border-color: color-mix(in oklab, var(--dsw-alias-brand-primary) 34%, var(--dsw-alias-border-l1)); }
.wx-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.wx-title { font-size: 13.5px; font-weight: 600; letter-spacing: 0.01em; margin: 0; }
.wx-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 2px 0 0; }
.wx-muted { color: var(--dsw-alias-label-secondary); }
.wx-mono { font-family: var(--wx-mono); font-size: 11.5px; }
.wx-num { font-variant-numeric: tabular-nums; }

.wx-fade { animation: wx-fade-up 260ms var(--wx-ease-out) both; }
@keyframes wx-fade-up {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── 页头 ── */
.wx-head { display: flex; align-items: flex-start; gap: 14px; }
.wx-head-mark {
  flex: none;
  width: 38px; height: 38px;
  border-radius: 11px;
  display: grid; place-items: center;
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 16%, transparent);
  color: var(--dsw-alias-brand-primary);
  border: 1px solid color-mix(in oklab, var(--dsw-alias-brand-primary) 26%, transparent);
}
.wx-head-text { flex: 1; min-width: 0; }
.wx-head-text h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
.wx-head-text p { margin: 3px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.wx-head-side { display: flex; align-items: center; gap: 8px; flex: none; }

/* ── 状态徽标 ── */
.wx-pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 10px 0 8px;
  border-radius: 999px;
  font-size: 11.5px; font-weight: 550;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.wx-pill-dot { position: relative; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.wx-pill--on { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in oklab, var(--dsw-alias-state-success-primary) 32%, var(--dsw-alias-border-l1)); }
.wx-pill--on .wx-pill-dot { background: var(--dsw-alias-state-success-primary); }
.wx-pill--on .wx-pill-dot::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-success-primary);
  animation: wx-ping 2.4s var(--wx-ease-out) infinite;
}
@keyframes wx-ping {
  0% { opacity: 0.7; transform: scale(0.6); }
  70%, 100% { opacity: 0; transform: scale(1.9); }
}
.wx-pill--warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 32%, var(--dsw-alias-border-l1)); }
.wx-pill--warn .wx-pill-dot { background: var(--dsw-alias-state-warn-primary); }
.wx-pill--err { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 32%, var(--dsw-alias-border-l1)); }
.wx-pill--err .wx-pill-dot { background: var(--dsw-alias-state-error-primary); }

/* ── 健康链路：微信 → 桥接 → Agent ── */
.wx-rail { display: flex; align-items: stretch; gap: 0; padding: 4px 0 2px; }
.wx-node { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.wx-node-name { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 550; }
.wx-node-name i { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.wx-node--on .wx-node-name i { background: var(--dsw-alias-state-success-primary); }
.wx-node--off .wx-node-name i { background: var(--dsw-alias-state-idle-primary); }
.wx-node--warn .wx-node-name i { background: var(--dsw-alias-state-warn-primary); }
.wx-node--warn .wx-node-name { color: var(--dsw-alias-label-primary); }
.wx-node--off .wx-node-name { color: var(--dsw-alias-label-secondary); }
.wx-node-desc { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wx-link { position: relative; flex: none; width: 34px; align-self: flex-start; height: 15px; margin: 0 6px; }
.wx-link::before {
  content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px;
  background: var(--dsw-alias-border-l2);
}
.wx-link--live::before { background: color-mix(in oklab, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-border-l2)); }
.wx-link--live::after {
  content: ''; position: absolute; top: calc(50% - 1.5px); left: 0;
  width: 3px; height: 3px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  animation: wx-flow 1.9s linear infinite;
}
@keyframes wx-flow {
  from { transform: translateX(0); opacity: 0; }
  20% { opacity: 1; }
  80% { opacity: 1; }
  to { transform: translateX(30px); opacity: 0; }
}

/* ── 指标 ── */
.wx-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
.wx-stat {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  padding: 12px 14px;
}
.wx-stat-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.wx-stat-value { font-size: 22px; font-weight: 620; letter-spacing: -0.02em; line-height: 1.25; font-variant-numeric: tabular-nums; }
.wx-stat-value span { font-size: 11.5px; font-weight: 500; color: var(--dsw-alias-label-secondary); margin-left: 2px; }

/* ── 步骤 ── */
.wx-steps { display: flex; flex-direction: column; }
.wx-step { position: relative; display: flex; gap: 13px; padding: 0 0 18px; }
.wx-step:last-child { padding-bottom: 0; }
.wx-step-rail { position: relative; flex: none; width: 22px; display: flex; flex-direction: column; align-items: center; }
.wx-step-dot {
  width: 22px; height: 22px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 11px; font-weight: 620;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  transition: transform 200ms var(--wx-ease-out), border-color 200ms ease, color 200ms ease, background-color 200ms ease;
}
.wx-step--active .wx-step-dot {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1));
  transform: scale(1.06);
}
.wx-step--done .wx-step-dot {
  border-color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-bg-base);
}
.wx-step--busy .wx-step-dot { animation: wx-breathe 1.1s var(--wx-ease-in-out) infinite; }
@keyframes wx-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }
.wx-step-line { flex: 1; width: 1px; margin-top: 5px; background: var(--dsw-alias-border-l1); }
.wx-step--done .wx-step-line { background: color-mix(in oklab, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l1)); }
.wx-step-body { flex: 1; min-width: 0; padding-top: 1px; }
.wx-step-name { font-size: 12.5px; font-weight: 600; }
.wx-step-desc { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin: 2px 0 8px; }
.wx-step-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wx-step-note { font-size: 11.5px; color: var(--dsw-alias-state-success-primary); }
.wx-step-note--err { color: var(--dsw-alias-state-error-primary); }

/* ── 按钮 ── */
.wx-btn {
  appearance: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 13px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; font-weight: 550;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 140ms var(--wx-ease-out), background-color 160ms ease, border-color 160ms ease, opacity 160ms ease;
}
.wx-btn:active:not(:disabled) { transform: scale(0.97); }
.wx-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.wx-btn:disabled { opacity: 0.5; cursor: default; }
.wx-btn--primary {
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
  color: var(--dsw-alias-bg-base);
}
.wx-btn--quiet { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.wx-btn--sm { height: 25px; padding: 0 9px; font-size: 11.5px; border-radius: 7px; }
.wx-btn--danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 34%, var(--dsw-alias-border-l2)); background: transparent; }
@media (hover: hover) and (pointer: fine) {
  .wx-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay); }
  .wx-btn--primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-brand-primary); }
  .wx-btn--quiet:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
  .wx-chat:hover { background: var(--dsw-alias-bg-layer-2); }
  .wx-copy:hover { color: var(--dsw-alias-label-primary); }
}

/* ── 分段标签 ── */
.wx-tabs {
  position: relative;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.wx-tab {
  position: relative; z-index: 1;
  appearance: none; border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12.5px; font-weight: 550;
  height: 28px; padding: 0 12px;
  border-radius: 8px;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: color 180ms ease, transform 140ms var(--wx-ease-out);
}
.wx-tab:active { transform: scale(0.97); }
.wx-tab--on { color: var(--dsw-alias-label-primary); }
.wx-tab-mark {
  position: absolute; z-index: 0; top: 3px; bottom: 3px; left: 3px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  transition: transform 260ms var(--wx-ease-out), width 260ms var(--wx-ease-out);
  will-change: transform, width;
}
.wx-tab-badge {
  min-width: 15px; height: 15px; padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 20%, transparent);
  color: var(--dsw-alias-brand-primary);
  font-size: 10px; font-weight: 620;
  display: inline-grid; place-items: center;
  font-variant-numeric: tabular-nums;
}

/* ── 列表行 ── */
.wx-rows { display: flex; flex-direction: column; }
.wx-row {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
}
.wx-row:first-child { border-top: 0; }
.wx-row-time { flex: none; width: 52px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.wx-row-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; margin-top: 7px; background: var(--dsw-alias-state-idle-primary); }
.wx-row-dot--info { background: var(--dsw-alias-brand-primary); }
.wx-row-dot--warn { background: var(--dsw-alias-state-warn-primary); }
.wx-row-dot--error { background: var(--dsw-alias-state-error-primary); }
.wx-row-dot--ok { background: var(--dsw-alias-state-success-primary); }
.wx-row-body { flex: 1; min-width: 0; }
.wx-row-main { font-size: 12px; overflow-wrap: anywhere; }
.wx-row-detail { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; margin-top: 1px; }
.wx-empty {
  padding: 18px 14px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 11px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  text-align: center;
  line-height: 1.7;
}

/* ── 会话 ── */
.wx-chats { display: grid; grid-template-columns: minmax(200px, 260px) 1fr; gap: 14px; align-items: start; }
@media (max-width: 720px) { .wx-chats { grid-template-columns: 1fr; } }
.wx-chat-list { display: flex; flex-direction: column; gap: 2px; max-height: 460px; overflow-y: auto; }
.wx-chat {
  display: flex; align-items: center; gap: 9px;
  width: 100%; text-align: left;
  appearance: none; border: 0; background: transparent;
  font: inherit; color: inherit;
  padding: 8px 9px; border-radius: 9px;
  cursor: pointer;
  transition: background-color 150ms ease, transform 140ms var(--wx-ease-out);
}
.wx-chat:active { transform: scale(0.985); }
.wx-chat--on { background: var(--dsw-alias-bg-layer-2); }
.wx-chat-body { flex: 1; min-width: 0; }
.wx-chat-name { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wx-chat-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wx-chat-unread {
  flex: none; min-width: 17px; height: 17px; padding: 0 4px;
  border-radius: 999px; background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-size: 11px; font-weight: 650;
  display: grid; place-items: center;
}
.wx-thread { display: flex; flex-direction: column; gap: 8px; max-height: 460px; overflow-y: auto; padding: 2px; }
.wx-bubble { display: flex; flex-direction: column; gap: 2px; max-width: 78%; }
.wx-bubble--in { align-self: flex-start; }
.wx-bubble--out { align-self: flex-end; align-items: flex-end; }
.wx-bubble-text {
  padding: 7px 11px;
  border-radius: 12px;
  font-size: 12.5px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.wx-bubble--out .wx-bubble-text {
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 14%, var(--dsw-alias-bg-layer-1));
  border-color: color-mix(in oklab, var(--dsw-alias-brand-primary) 26%, var(--dsw-alias-border-l1));
}
.wx-bubble-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary); padding: 0 3px; font-variant-numeric: tabular-nums; }

/* ── 表单 ── */
.wx-form { display: flex; flex-direction: column; }
.wx-field {
  display: grid;
  grid-template-columns: minmax(150px, 210px) 1fr;
  gap: 6px 16px;
  padding: 11px 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
  align-items: start;
}
.wx-field:first-child { border-top: 0; }
@media (max-width: 640px) { .wx-field { grid-template-columns: 1fr; } }
.wx-field-label { font-size: 12.5px; font-weight: 550; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wx-field-hint { grid-column: 1; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.wx-field-control { min-width: 0; }
.wx-input, .wx-select, .wx-textarea {
  width: 100%;
  font: inherit; font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 6px 9px;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.wx-input:focus, .wx-select:focus, .wx-textarea:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--dsw-alias-brand-primary) 16%, transparent);
}
.wx-input.wx-mono, .wx-textarea.wx-mono { font-family: var(--wx-mono); font-size: 11.5px; }
.wx-textarea { resize: vertical; min-height: 62px; line-height: 1.5; }
.wx-select { appearance: none; padding-right: 26px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 14px) calc(50% - 1px), calc(100% - 9px) calc(50% - 1px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.wx-toggle { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; font-size: 12.5px; }
.wx-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.wx-toggle-track {
  flex: none; position: relative;
  width: 34px; height: 20px; border-radius: 999px;
  background: var(--dsw-alias-state-idle-primary);
  transition: background-color 200ms ease;
}
.wx-toggle-track::after {
  content: '';
  position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
  transition: transform 220ms var(--wx-ease-out);
}
.wx-toggle input:checked + .wx-toggle-track { background: var(--dsw-alias-brand-primary); }
.wx-toggle input:checked + .wx-toggle-track::after { transform: translateX(14px); }
.wx-toggle input:focus-visible + .wx-toggle-track { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.wx-checkline { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; cursor: pointer; }
.wx-checkline input { margin: 3px 0 0; accent-color: var(--dsw-alias-brand-primary); }

.wx-copy {
  appearance: none; border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; cursor: pointer;
  padding: 1px 5px; border-radius: 5px;
  transition: color 140ms ease, background-color 140ms ease;
}
.wx-inline { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wx-inline-code {
  flex: 1; min-width: 0;
  font-family: var(--wx-mono); font-size: 11.5px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  padding: 5px 8px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── 保存条 ── */
.wx-savebar {
  position: sticky; bottom: 0; z-index: 3;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 2px;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  animation: wx-rise 220ms var(--wx-ease-out) both;
}
@keyframes wx-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

/* ── 体检 ── */
.wx-check-row { display: flex; gap: 11px; padding: 11px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.wx-check-row:first-child { border-top: 0; }
.wx-check-mark {
  flex: none; width: 18px; height: 18px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 10px; font-weight: 700;
  border: 1px solid currentColor;
}
.wx-check-mark--ok { color: var(--dsw-alias-state-success-primary); }
.wx-check-mark--warn { color: var(--dsw-alias-state-warn-primary); }
.wx-check-mark--error { color: var(--dsw-alias-state-error-primary); }
.wx-check-body { flex: 1; min-width: 0; }
.wx-check-title { font-size: 12.5px; font-weight: 550; }
.wx-check-detail { font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.wx-check-fix {
  margin-top: 5px; font-size: 11.5px;
  color: var(--dsw-alias-brand-primary);
  background: color-mix(in oklab, var(--dsw-alias-brand-primary) 9%, transparent);
  border-radius: 7px; padding: 5px 8px;
  overflow-wrap: anywhere;
}
.wx-meter { display: flex; align-items: center; gap: 10px; }
.wx-meter-track { flex: 1; height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.wx-meter-fill {
  height: 100%; border-radius: inherit;
  background: var(--dsw-alias-state-success-primary);
  transform-origin: left center;
  transition: transform 220ms var(--wx-ease-out), background-color 180ms ease;
}
.wx-meter--warn .wx-meter-fill { background: var(--dsw-alias-state-warn-primary); }
.wx-meter--err .wx-meter-fill { background: var(--dsw-alias-state-error-primary); }

.wx-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; align-items: start; }
.wx-notice {
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--dsw-alias-state-warn-primary) 34%, var(--dsw-alias-border-l1));
  background: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}
.wx-notice--err { border-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 34%, var(--dsw-alias-border-l1)); background: color-mix(in oklab, var(--dsw-alias-state-error-primary) 8%, transparent); }
.wx-error-line { color: var(--dsw-alias-state-error-primary); font-size: 11.5px; margin-top: 6px; overflow-wrap: anywhere; }
.wx-ok-line { color: var(--dsw-alias-state-success-primary); font-size: 11.5px; margin-top: 6px; }
.wx-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

@media (prefers-reduced-motion: reduce) {
  .wx-page *, .wx-page *::before, .wx-page *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .wx-fade { animation: none; opacity: 1; }
}
`;

    /* ═════════════════════════════ 工具函数 ═════════════════════════════ */

    function isRecord(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function asText(value) {
      return value === null || value === undefined ? '' : String(value);
    }

    function asList(value) {
      return Array.isArray(value) ? value : [];
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** 短时间：今天只给 时:分，隔天给 月-日 时:分。 */
    function formatClock(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
      const date = new Date(milliseconds);
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
      const clock = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
      return sameDay ? clock : (pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + clock);
    }

    function formatFull(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
      const date = new Date(milliseconds);
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    function formatAgo(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
      const delta = Date.now() - milliseconds;
      if (delta < 45000) return T('common.justNow');
      const minutes = Math.round(delta / 60000);
      if (minutes < 60) return T('common.minutesAgo', { count: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return T('common.hoursAgo', { count: hours });
      return T('common.daysAgo', { count: Math.round(hours / 24) });
    }

    function formatDuration(milliseconds) {
      const total = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (days > 0) return days + 'd ' + hours + 'h';
      if (hours > 0) return hours + 'h ' + minutes + 'm';
      if (minutes > 0) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    }

    /** 列表输入：换行/逗号/空格分隔都接受，返回数组。 */
    function splitList(value) {
      return asText(value).split(/[\n,，\s]+/).map(function trim(item) { return item.trim(); }).filter(Boolean);
    }

    function joinList(value) {
      return asList(value).filter(Boolean).join('\n');
    }

    function truncate(value, max) {
      const text = asText(value);
      return text.length <= max ? text : text.slice(0, max - 1) + '…';
    }

    /* ═════════════════════════════ 传输 ═════════════════════════════ */

    async function readJson(response) {
      try {
        const text = await response.text();
        if (typeof text !== 'string' || text.trim() === '') return null;
        return JSON.parse(text);
      } catch (error) {
        return null;
      }
    }

    function httpFailure(status) {
      return T('action.httpError', { status: status });
    }

    /** GET：永不抛；404 单独标记为「Host 半边没挂」。 */
    async function getJson(route, signal) {
      let response;
      try {
        response = await fetch(route, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: signal,
        });
      } catch (error) {
        if (signal && signal.aborted) return { ok: false, aborted: true };
        return { ok: false, code: 'unreachable', message: T('action.unreachable') };
      }
      const payload = await readJson(response);
      if (response.status === 404) {
        return { ok: false, kind: 'missing', code: 'http-404', message: httpFailure(404) };
      }
      if (!response.ok) {
        return { ok: false, code: 'http-' + response.status, message: httpFailure(response.status) };
      }
      if (!isRecord(payload)) {
        return { ok: false, code: 'bad-payload', message: T('host.badPayload') };
      }
      return { ok: true, data: payload };
    }

    /** POST/PUT：带超时，永不抛。 */
    async function send(method, route, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (controller !== null && typeof globalThis.setTimeout === 'function') {
        timer = globalThis.setTimeout(function abortSlow() {
          try { controller.abort(); } catch (error) { /* ignore */ }
        }, ACTION_TIMEOUT_MS);
      }
      try {
        const response = await fetch(route, {
          method: method,
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
          signal: controller === null ? undefined : controller.signal,
        });
        const payload = await readJson(response);
        if (response.ok) return isRecord(payload) ? payload : { ok: true };
        if (isRecord(payload) && typeof payload.message === 'string') return payload;
        return { ok: false, code: 'http-' + response.status, message: httpFailure(response.status) };
      } catch (error) {
        if (controller !== null && controller.signal && controller.signal.aborted) {
          return { ok: false, code: 'timeout', message: T('action.timeout') };
        }
        return { ok: false, code: 'unreachable', message: T('action.unreachable') };
      } finally {
        if (timer !== null) globalThis.clearTimeout(timer);
      }
    }

    function postJson(route, body) { return send('POST', route, body); }
    function putJson(route, body) { return send('PUT', route, body); }

    /** 把失败对象渲染成一行字。 */
    function describeFailure(result) {
      if (!isRecord(result)) return T('action.failed', { code: 'unknown' });
      const code = typeof result.code === 'string' && result.code !== '' ? result.code : 'unknown';
      const message = typeof result.message === 'string' && result.message !== '' ? result.message : '';
      return message === '' ? T('action.failed', { code: code }) : message;
    }

    /* ═════════════════════════════ 图标 ═════════════════════════════ */

    /** 16×16 线性图标；crisp 用 1.3 描边，选中态加粗到 1.5。 */
    const ICONS = {
      grid: ['M2.6 2.6h4.4v4.4H2.6z', 'M9 2.6h4.4v4.4H9z', 'M2.6 9h4.4v4.4H2.6z', 'M9 9h4.4v4.4H9z'],
      chat: ['M13.4 8.6c0 2.5-2.4 4.5-5.4 4.5-.7 0-1.4-.1-2-.3L2.9 13.7l.9-2.4C3 10.5 2.6 9.6 2.6 8.6c0-2.5 2.4-4.5 5.4-4.5s5.4 2 5.4 4.5Z'],
      terminal: ['M3 4.4 6.2 8 3 11.6', 'M7.8 11.9h5.2'],
      sliders: ['M2.6 4.6h10.8', 'M2.6 11.4h10.8', 'M6 2.8v3.6', 'M10.4 9.6v3.6'],
      check: ['M3 8.4 6.2 11.6 13 3.6'],
      shield: ['M8 2.2 12.8 4v3.9c0 3-1.9 5.2-4.8 6.4C5.1 13.1 3.2 10.9 3.2 7.9V4L8 2.2Z', 'M5.9 7.8 7.4 9.4 10.2 6.3'],
      refresh: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13.3 2.4v3.2h-3.2'],
      copy: ['M5.4 5.4h7.2v7.2H5.4z', 'M10.6 5.4V3.4H3.4v7.2h2'],
      bolt: ['M8.8 2.2 3.6 9.1h3.6l-.6 4.7 5.2-6.9H8.2l.6-4.7Z'],
      play: ['M5.2 3.4 12 8l-6.8 4.6V3.4Z'],
      stop: ['M4.4 4.4h7.2v7.2H4.4z'],
      link: ['M6.6 9.4 9.4 6.6', 'M7.4 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1', 'M8.6 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1'],
      alert: ['M8 2.8 14 13H2L8 2.8Z', 'M8 6.6v3', 'M8 11.2v.1'],
      wechat: ['M12.6 7.6c0 2-1.9 3.6-4.2 3.6-.5 0-1.1-.1-1.6-.2L4.2 12.2l.7-1.9C3.7 9.6 3.2 8.7 3.2 7.6c0-2 1.9-3.6 4.2-3.6s5.2 1.6 5.2 3.6Z'],
      spark: ['M8 2.4v3', 'M8 10.6v3', 'M2.4 8h3', 'M10.6 8h3', 'M4.4 4.4l2 2', 'M9.6 9.6l2 2', 'M11.6 4.4l-2 2', 'M6.4 9.6l-2 2'],
      clock: ['M8 3.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Z', 'M8 5.6V8l1.8 1.1'],
    };

    function Icon(props) {
      const name = typeof props.name === 'string' && ICONS[props.name] ? props.name : 'spark';
      const size = Number.isFinite(props.size) && props.size > 0 ? props.size : 14;
      const paths = ICONS[name];
      const children = [];
      for (let index = 0; index < paths.length; index++) {
        children.push(h('path', { key: 'p' + index, d: paths[index] }));
      }
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.bold ? 1.5 : 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
      }, children);
    }

    /* ═════════════════════════════ 小组件 ═════════════════════════════ */

    function Card(props) {
      const classes = ['wx-card'];
      if (props.flush) classes.push('wx-card--flush');
      if (props.accent) classes.push('wx-card--accent');
      if (props.delay === undefined) classes.push('wx-fade');
      return h('section', {
        className: classes.join(' '),
        style: props.delay === undefined ? undefined : { animationDelay: props.delay + 'ms' },
      }, props.children);
    }

    function CardHead(props) {
      return h('div', { className: 'wx-card-head' },
        h('div', { style: { minWidth: 0 } },
          h('h2', { className: 'wx-title' }, props.title),
          props.sub ? h('p', { className: 'wx-sub' }, props.sub) : null),
        props.side ? h('div', { style: { flex: 'none' } }, props.side) : null);
    }

    function Pill(props) {
      const tone = props.tone === 'on' || props.tone === 'warn' || props.tone === 'err' ? ' wx-pill--' + props.tone : '';
      return h('span', { className: 'wx-pill' + tone, role: 'status' },
        h('span', { className: 'wx-pill-dot', 'aria-hidden': 'true' }),
        props.children);
    }

    function Btn(props) {
      const classes = ['wx-btn'];
      if (props.variant === 'primary') classes.push('wx-btn--primary');
      if (props.variant === 'quiet') classes.push('wx-btn--quiet');
      if (props.variant === 'danger') classes.push('wx-btn--danger');
      if (props.small) classes.push('wx-btn--sm');
      return h('button', {
        type: 'button',
        className: classes.join(' '),
        onClick: props.onClick,
        disabled: Boolean(props.disabled),
        title: props.title,
      },
        props.icon ? h(Icon, { name: props.icon, size: props.small ? 12 : 13 }) : null,
        props.children);
    }

    function CopyInline(props) {
      const [copied, setCopied] = React.useState(false);
      const timerRef = React.useRef(null);
      React.useEffect(function clearCopyTimer() {
        return function cleanup() {
          if (timerRef.current !== null) globalThis.clearTimeout(timerRef.current);
        };
      }, []);
      const onCopy = function onCopy() {
        const text = asText(props.value);
        if (text === '') return;
        const done = function done() {
          setCopied(true);
          if (timerRef.current !== null) globalThis.clearTimeout(timerRef.current);
          timerRef.current = globalThis.setTimeout(function reset() { setCopied(false); }, 1600);
        };
        try {
          if (globalThis.navigator && globalThis.navigator.clipboard && typeof globalThis.navigator.clipboard.writeText === 'function') {
            globalThis.navigator.clipboard.writeText(text).then(done, function fallback() {
              if (typeof props.onFallback === 'function') props.onFallback(text);
            });
            return;
          }
        } catch (error) { /* 落到兜底 */ }
        if (typeof props.onFallback === 'function') props.onFallback(text);
      };
      return h('div', { className: 'wx-inline' },
        h('code', { className: 'wx-inline-code', title: asText(props.value) }, asText(props.value) || T('common.dash')),
        h('button', { type: 'button', className: 'wx-copy', onClick: onCopy }, copied ? T('common.copied') : T('common.copy')));
    }

    function Empty(props) {
      return h('div', { className: 'wx-empty' }, props.children);
    }

    function Field(props) {
      return h('div', { className: 'wx-field' },
        h('div', { className: 'wx-field-label' },
          props.label,
          props.badge ? h('span', { className: 'wx-pill wx-pill--warn', style: { height: '18px', fontSize: '10.5px', padding: '0 7px' } },
            h(Icon, { name: 'clock', size: 10 }),
            T('settings.reload')) : null),
        h('div', { className: 'wx-field-hint' }, props.hint || ''),
        h('div', { className: 'wx-field-control' }, props.children));
    }

    function Toggle(props) {
      return h('label', { className: 'wx-toggle' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: function onChange(event) { props.onChange(event.target.checked); },
        }),
        h('span', { className: 'wx-toggle-track', 'aria-hidden': 'true' }),
        h('span', null, props.label));
    }

    function Meter(props) {
      const total = Math.max(1, Number(props.total) || 1);
      const value = Math.max(0, Math.min(total, Number(props.value) || 0));
      const ratio = value / total;
      const tone = ratio >= 1 ? '' : ratio >= 0.6 ? ' wx-meter--warn' : ' wx-meter--err';
      return h('div', { className: 'wx-meter' + tone },
        h('div', { className: 'wx-meter-track' },
          h('div', {
            className: 'wx-meter-fill',
            style: { transform: 'scaleX(' + (ratio === 0 ? 0 : ratio).toFixed(4) + ')' },
          })),
        h('span', { className: 'wx-num', style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } },
          value + '/' + total));
    }

    /** 数字滚动：轻量 rAF 补间，尊重 prefers-reduced-motion。 */
    function CountUp(props) {
      const target = Number(props.value) || 0;
      const [shown, setShown] = React.useState(target);
      const fromRef = React.useRef(target);
      const rafRef = React.useRef(null);
      React.useEffect(function tween() {
        let reduce = false;
        try {
          reduce = Boolean(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (error) { reduce = false; }
        const from = fromRef.current;
        if (reduce || from === target || typeof globalThis.requestAnimationFrame !== 'function') {
          fromRef.current = target;
          setShown(target);
          return undefined;
        }
        const started = Date.now();
        const duration = 420;
        const step = function step() {
          const progress = Math.min(1, (Date.now() - started) / duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          const value = Math.round(from + (target - from) * eased);
          setShown(value);
          if (progress < 1) {
            rafRef.current = globalThis.requestAnimationFrame(step);
          } else {
            fromRef.current = target;
            rafRef.current = null;
          }
        };
        rafRef.current = globalThis.requestAnimationFrame(step);
        return function cancel() {
          if (rafRef.current !== null) {
            try { globalThis.cancelAnimationFrame(rafRef.current); } catch (error) { /* ignore */ }
            rafRef.current = null;
          }
          fromRef.current = shown;
        };
      }, [target]);
      return h('span', { className: 'wx-num' }, shown);
    }

    /* ═════════════════════════════ 总览 ═════════════════════════════ */

    /**
     * 三个节点的健康态。
     * 只有「配好了」和「真的通过」分开讲，才不会出现满屏绿灯但消息发不出去的情况。
     * 状态取值：on = 已验证可用；warn = 配好了但还没验证 / 上次失败；off = 没配。
     */
    function HealthRail(props) {
      const config = isRecord(props.config) ? props.config : {};
      const gateway = isRecord(config.gateway) ? config.gateway : {};
      const presets = asList(props.presets);
      const deliveries = asList(props.deliveries);
      const counters = isRecord(props.counters) ? props.counters : {};
      const presetId = asText(config.agentPreset);
      const kind = asText(config.kind);

      /* ── 微信侧：genuine 网关地址 + 最近一次投递是否成功 ── */
      const outboundConfigured = kind === 'official' || kind === 'wecom' ? true : Boolean(gateway.sendUrl);
      const lastDelivery = deliveries.length > 0 ? deliveries[0] : null;
      const lastDeliveryFailed = lastDelivery !== null && lastDelivery.ok === false;
      const everDelivered = deliveries.some(function pass(item) { return item.ok === true; });

      let wechatState = 'off';
      let wechatDesc = T('health.wechat.off');
      if (outboundConfigured) {
        if (lastDeliveryFailed) {
          wechatState = 'warn';
          wechatDesc = T('health.wechat.failed');
        } else if (!everDelivered) {
          wechatState = 'warn';
          wechatDesc = T('health.wechat.unverified');
        } else {
          wechatState = 'on';
          wechatDesc = kind === 'generic' ? truncate(asText(gateway.sendUrl), 30) : kind;
        }
      }

      /* ── 桥接：webhook 有没有在听 ── */
      const bridgeOn = Boolean(config.webhookPath);
      const inboundCount = Number(counters.inbound) || 0;
      const bridgeState = bridgeOn ? 'on' : 'off';
      const bridgeDesc = bridgeOn
        ? T('health.bridge.listening', { path: asText(config.webhookPath) })
        : T('common.dash');

      /* ── agent：服务和预设 ── */
      const presetFound = presets.some(function match(preset) { return asText(preset.id) === presetId; });
      let agentState = 'off';
      let agentDesc = T('health.agent.off');
      if (!props.agentServices) {
        agentDesc = T('health.agent.noService');
      } else if (!presetId) {
        agentDesc = T('health.agent.unset');
      } else if (presetFound) {
        agentState = 'on';
        agentDesc = presetId;
      }

      const nodes = [
        { id: 'wechat', name: T('health.wechat'), state: wechatState, desc: wechatDesc },
        { id: 'bridge', name: T('health.bridge'), state: bridgeState, desc: bridgeDesc },
        { id: 'agent', name: T('health.agent'), state: agentState, desc: agentDesc },
      ];

      const children = [];
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (index > 0) {
          const previous = nodes[index - 1];
          const live = previous.state === 'on' && node.state === 'on';
          children.push(h('span', {
            key: 'link' + index,
            className: 'wx-link' + (live ? ' wx-link--live' : ''),
            'aria-hidden': 'true',
          }));
        }
        children.push(h('div', { key: node.id, className: 'wx-node wx-node--' + node.state },
          h('div', { className: 'wx-node-name' }, h('i', { 'aria-hidden': 'true' }), node.name),
          h('div', { className: 'wx-node-desc', title: node.desc }, node.desc)));
      }

      /* 话术跟着最差的那个节点走：不骗人，也不吓人。 */
      const states = nodes.map(function pick(node) { return node.state; });
      let hint = 'health.hint';
      if (states.indexOf('off') >= 0) hint = 'health.hint.off';
      else if (states.indexOf('warn') >= 0) hint = 'health.hint.warn';

      return h('div', null,
        h('div', { className: 'wx-rail' }, children),
        h('p', { className: 'wx-sub', style: { marginTop: '10px' } }, T(hint)));
    }

    function StatTile(props) {
      return h('div', { className: 'wx-stat' },
        h('div', { className: 'wx-stat-label' }, props.label),
        h('div', { className: 'wx-stat-value' },
          h(CountUp, { value: props.value }),
          props.unit ? h('span', null, props.unit) : null));
    }

    function WizardStep(props) {
      const status = props.status;
      const stepClass = 'wx-step'
        + (status === 'done' ? ' wx-step--done' : '')
        + (status === 'busy' ? ' wx-step--busy' : '')
        + (status === 'active' ? ' wx-step--active' : '');
      return h('div', { className: stepClass },
        h('div', { className: 'wx-step-rail' },
          h('div', { className: 'wx-step-dot', 'aria-hidden': 'true' },
            status === 'done' ? h(Icon, { name: 'check', size: 12, bold: true }) : String(props.index + 1)),
          h('div', { className: 'wx-step-line', 'aria-hidden': 'true' })),
        h('div', { className: 'wx-step-body' },
          h('div', { className: 'wx-step-name' }, props.title),
          h('div', { className: 'wx-step-desc' }, props.desc),
          h('div', { className: 'wx-step-actions' },
            h(Btn, {
              variant: status === 'done' ? undefined : 'primary',
              icon: props.icon,
              disabled: Boolean(props.disabled) || status === 'busy' || status === 'done',
              onClick: props.onAction,
            }, status === 'busy' ? props.busyLabel : (status === 'done' ? props.doneLabel : props.actionLabel)),
            props.note ? h('span', {
              className: 'wx-step-note' + (props.noteTone === 'err' ? ' wx-step-note--err' : ''),
            }, props.note) : null)));
    }

    function OverviewTab(props) {
      const snap = props.snapshot;
      const config = isRecord(snap.config) ? snap.config : {};
      const counters = isRecord(snap.counters) ? snap.counters : {};
      const stub = isRecord(snap.stub) ? snap.stub : {};
      const wizard = props.wizard;
      const events = asList(snap.events).slice(0, MAX_EVENTS);
      const deliveries = asList(snap.deliveries);
      const doneCount = WIZARD_STEPS.filter(function isDone(step) { return wizard.step === step || WIZARD_STEPS.indexOf(wizard.step) > WIZARD_STEPS.indexOf(step) || wizard.completed === true; }).length;
      const allDone = wizard.completed === true;

      const stepStatuses = {
        stub: allDone || wizard.done && wizard.done.stub ? 'done' : (wizard.step === 'stub' ? (wizard.busy ? 'busy' : 'active') : 'active'),
        point: allDone || (wizard.done && wizard.done.stub && wizard.done.point) ? 'done' : (wizard.step === 'point' ? (wizard.busy ? 'busy' : 'active') : 'idle'),
        ping: allDone || (wizard.done && wizard.done.stub && wizard.done.point && wizard.done.ping) ? 'done' : (wizard.step === 'ping' ? (wizard.busy ? 'busy' : 'active') : 'idle'),
      };

      const stubUrl = '127.0.0.1:' + (Number(stub.port) > 0 ? Number(stub.port) : STUB_PORT_FALLBACK) + '/send';

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },

        h(Card, { delay: 0 },
          h(CardHead, { title: T('health.bridge'), sub: T('panel.subtitle') }),
          h(HealthRail, {
            config: config,
            presets: snap.presets,
            agentServices: snap.agentServices,
            deliveries: snap.deliveries,
            counters: counters,
          })),

        h('div', { className: 'wx-stats wx-fade', style: { animationDelay: '40ms' } },
          h(StatTile, { label: T('stat.inbound'), value: Number(counters.inbound) || 0, unit: T('stat.unit') }),
          h(StatTile, { label: T('stat.outbound'), value: Number(counters.outbound) || 0, unit: T('stat.unit') }),
          h(StatTile, { label: T('stat.replies'), value: Number(counters.replies) || 0, unit: T('stat.unit') }),
          h(StatTile, { label: T('stat.errors'), value: Number(counters.errors) || 0, unit: T('stat.unit') })),

        h(Card, { delay: 80, accent: !allDone },
          h(CardHead, {
            title: allDone ? T('wizard.done') : T('wizard.title'),
            sub: allDone ? T('wizard.doneHint') : T('wizard.subtitle'),
            side: h('span', { className: 'wx-muted', style: { fontSize: '11.5px' } },
              h(Icon, { name: 'spark', size: 11 }),
              ' ' + T('wizard.progress', { done: allDone ? WIZARD_STEPS.length : Math.max(1, doneCount), total: WIZARD_STEPS.length })),
          }),

          allDone
            ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h(Btn, {
                  icon: 'play',
                  onClick: function restart() { props.onWizardReset(); },
                }, T('wizard.reset')),
                h(Btn, {
                  icon: 'stop',
                  onClick: function stopStub() { props.onStubStop(); },
                }, T('wizard.stop')))
            : h('div', { className: 'wx-steps' },
                h(WizardStep, {
                  index: 0,
                  title: T('wizard.stub.title'),
                  desc: T('wizard.stub.desc'),
                  status: stepStatuses.stub,
                  icon: 'play',
                  actionLabel: T('wizard.stub.action'),
                  busyLabel: T('wizard.stub.running'),
                  doneLabel: T('wizard.stub.done'),
                  note: stub.running ? T('console.stub.on', { port: stub.port }) : '',
                  onAction: props.onStubStart,
                }),
                h(WizardStep, {
                  index: 1,
                  title: T('wizard.point.title'),
                  desc: T('wizard.point.desc'),
                  status: stepStatuses.point,
                  icon: 'link',
                  actionLabel: T('wizard.point.action'),
                  busyLabel: T('wizard.point.running'),
                  doneLabel: T('wizard.point.done', { url: stubUrl }),
                  disabled: !stub.running,
                  note: !stub.running ? T('wizard.point.needStub') : '',
                  noteTone: 'err',
                  onAction: function point() { props.onPointAtStub(stubUrl); },
                }),
                h(WizardStep, {
                  index: 2,
                  title: T('wizard.ping.title'),
                  desc: T('wizard.ping.desc'),
                  status: stepStatuses.ping,
                  icon: 'bolt',
                  actionLabel: T('wizard.ping.action'),
                  busyLabel: T('wizard.ping.running'),
                  doneLabel: T('wizard.ping.done'),
                  disabled: !stub.running,
                  onAction: props.onPing,
                })),
          wizard.error ? h('div', { className: 'wx-error-line' }, wizard.error) : null),

        h('div', { className: 'wx-split' },
          h(Card, { delay: 120 },
            h(CardHead, {
              title: T('events.title'),
              sub: T('events.note', { count: MAX_EVENTS }),
            }),
            events.length === 0
              ? h(Empty, null, T('events.empty'))
              : h('div', { className: 'wx-rows' }, events.map(function renderEvent(event, index) {
                  const level = asText(event.level);
                  const dotClass = level === 'error' ? 'err' : level === 'warn' ? 'warn' : 'info';
                  return h('div', { key: 'ev' + index, className: 'wx-row' },
                    h('span', { className: 'wx-row-time' }, formatClock(Number(event.at))),
                    h('span', { className: 'wx-row-dot wx-row-dot--' + dotClass, 'aria-hidden': 'true' }),
                    h('div', { className: 'wx-row-body' },
                      h('div', { className: 'wx-row-main' }, asText(event.message) || T('common.dash')),
                      event.detail ? h('div', { className: 'wx-row-detail' }, asText(event.detail)) : null));
                }))),

          h(Card, { delay: 160 },
            h(CardHead, { title: T('deliveries.title') }),
            deliveries.length === 0
              ? h(Empty, null, T('deliveries.empty'))
              : h('div', { className: 'wx-rows' }, deliveries.map(function renderDelivery(item, index) {
                  const phase = asText(item.phase);
                  const phaseKey = 'deliveries.phase.' + phase;
                  const phaseLabel = phase === 'stub' || phase === 'manual' || phase === 'reply' ? T(phaseKey) : phase;
                  return h('div', { key: 'dl' + index, className: 'wx-row' },
                    h('span', { className: 'wx-row-time' }, formatClock(Number(item.at))),
                    h('span', {
                      className: 'wx-row-dot ' + (item.ok ? 'wx-row-dot--ok' : 'wx-row-dot--error'),
                      'aria-hidden': 'true',
                    }),
                    h('div', { className: 'wx-row-body' },
                      h('div', { className: 'wx-row-main' },
                        phaseLabel + ' · ' + (item.ok ? T('deliveries.ok') : T('deliveries.fail'))),
                      h('div', { className: 'wx-row-detail' },
                        asText(item.chatId) ? asText(item.chatId) + ' · ' : '',
                        truncate(asText(item.text), 90) || T('common.dash'))));
                })))));
    }

    /* ═════════════════════════════ 会话 ═════════════════════════════ */

    function ChatsTab(props) {
      const snap = props.snapshot;
      const chats = asList(snap.chats);
      const [activeId, setActiveId] = React.useState('');
      const [thread, setThread] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [marking, setMarking] = React.useState(false);
      const [markNote, setMarkNote] = React.useState('');
      const tick = props.tick;

      /* 列表变化时修正选中项：选中的会话被清掉就退回第一个。 */
      React.useEffect(function keepSelectionValid() {
        if (chats.length === 0) {
          if (activeId !== '') setActiveId('');
          return;
        }
        const exists = chats.some(function match(chat) { return asText(chat.chatId) === activeId; });
        if (!exists) setActiveId(asText(chats[0].chatId));
      }, [chats.map(function id(chat) { return asText(chat.chatId); }).join('|'), activeId]);

      /* 拉取当前会话的消息。 */
      React.useEffect(function loadThread() {
        if (activeId === '') {
          setThread(null);
          return undefined;
        }
        let cancelled = false;
        setLoading(true);
        getJson(ROUTES.chats + '?chatId=' + encodeURIComponent(activeId) + '&limit=100')
          .then(function apply(result) {
            if (cancelled) return;
            setLoading(false);
            if (result.ok) {
              setThread(result.data);
              setError('');
            } else {
              setError(describeFailure(result));
            }
          });
        return function cancel() { cancelled = true; };
      }, [activeId, tick]);

      const active = chats.find(function match(chat) { return asText(chat.chatId) === activeId; });
      const messages = isRecord(thread) ? asList(thread.messages) : [];

      const onMarkRead = function onMarkRead() {
        if (activeId === '') return;
        setMarking(true);
        postJson(ROUTES.read, { chatId: activeId }).then(function done(result) {
          setMarking(false);
          if (result.ok) {
            setMarkNote(T('chats.markReadDone', { seq: result.readThroughSeq }));
            props.onRefresh();
          } else {
            setMarkNote(describeFailure(result));
          }
        });
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        h(Card, { delay: 0 },
          h(CardHead, { title: T('chats.title'), sub: T('chats.subtitle') }),
          chats.length === 0
            ? h(Empty, null, T('chats.empty'))
            : h('div', { className: 'wx-chats' },
                h('div', { className: 'wx-chat-list', role: 'list' },
                  chats.map(function renderChat(chat) {
                    const chatId = asText(chat.chatId);
                    const unread = Number(chat.unread) || 0;
                    const count = Number(chat.messages) || 0;
                    return h('button', {
                      key: chatId,
                      type: 'button',
                      role: 'listitem',
                      className: 'wx-chat' + (chatId === activeId ? ' wx-chat--on' : ''),
                      onClick: function pick() { setActiveId(chatId); setMarkNote(''); },
                    },
                      h('div', { className: 'wx-chat-body' },
                        h('div', { className: 'wx-chat-name' }, asText(chat.name) || chatId),
                        h('div', { className: 'wx-chat-meta' },
                          asText(chat.kind) === 'group' ? T('chats.dir.in') + '×' + (Number(chat.members) || 0) + ' · ' : '',
                          T('chats.messages', { count: count }),
                          Number(chat.lastAt) > 0 ? ' · ' + formatAgo(Number(chat.lastAt)) : '')),
                      unread > 0 ? h('span', { className: 'wx-chat-unread' }, unread > 99 ? '99+' : unread) : null);
                  })),

                h('div', { style: { minWidth: 0 } },
                  active === undefined
                    ? h(Empty, null, T('chats.pick'))
                    : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                          h('span', { style: { fontSize: '12.5px', fontWeight: 600 } }, asText(active.name) || asText(active.chatId)),
                          Number(active.unread) > 0
                            ? h('span', { className: 'wx-pill wx-pill--warn', style: { height: '19px', fontSize: '10.5px', padding: '0 7px' } },
                                T('chats.unread', { count: Number(active.unread) }))
                            : null,
                          h('span', { style: { flex: 1 } }),
                          h(Btn, {
                            small: true,
                            icon: 'check',
                            disabled: marking || Number(active.unread) === 0,
                            onClick: onMarkRead,
                          }, T('chats.markRead')), markNote ? h('span', { className: 'wx-muted', style: { fontSize: '11px' } }, markNote) : null),

                        error !== '' ? h('div', { className: 'wx-error-line' }, error) : null,
                        loading && messages.length === 0
                          ? h(Empty, null, T('chats.loading'))
                          : (messages.length === 0
                              ? h(Empty, null, T('chats.threadEmpty'))
                              : h('div', { className: 'wx-thread' }, messages.map(function renderMessage(message, index) {
                                  const out = asText(message.direction) === 'out';
                                  return h('div', {
                                    key: 'msg' + index,
                                    className: 'wx-bubble ' + (out ? 'wx-bubble--out' : 'wx-bubble--in'),
                                  },
                                    h('div', { className: 'wx-bubble-text' }, asText(message.text)),
                                    h('div', { className: 'wx-bubble-meta' },
                                      (out ? T('chats.dir.out') : T('chats.dir.in'))
                                      + ' · #' + asText(message.seq)
                                      + (asText(message.senderName) ? ' · ' + asText(message.senderName) : '')
                                      + ' · ' + formatClock(Number(message.time))));
                                }))))))));
    }

    /* ═════════════════════════════ 控制台 ═════════════════════════════ */

    function ConsoleTab(props) {
      const snap = props.snapshot;
      const stub = isRecord(snap.stub) ? snap.stub : {};
      const config = isRecord(snap.config) ? snap.config : {};
      const gateway = isRecord(config.gateway) ? config.gateway : {};

      const [chatId, setChatId] = React.useState('wechat-test');
      const [text, setText] = React.useState('面板里造的一条测试消息');
      const [wake, setWake] = React.useState(false);
      const [sending, setSending] = React.useState(false);
      const [inboundNote, setInboundNote] = React.useState('');
      const [inboundErr, setInboundErr] = React.useState('');

      const [outChatId, setOutChatId] = React.useState('');
      const [outText, setOutText] = React.useState('来自 DSH 面板的测试投递');
      const [outSending, setOutSending] = React.useState(false);
      const [outNote, setOutNote] = React.useState('');
      const [outErr, setOutErr] = React.useState('');

      const [port, setPort] = React.useState(String(Number(stub.port) > 0 ? Number(stub.port) : STUB_PORT_FALLBACK));
      const [stubBusy, setStubBusy] = React.useState(false);
      const [stubErr, setStubErr] = React.useState('');
      const [resetBusy, setResetBusy] = React.useState(false);
      const [resetNote, setResetNote] = React.useState('');

      /* 出站会话默认跟着第一个会话走。 */
      React.useEffect(function defaultOutChat() {
        if (outChatId !== '') return;
        const first = asList(snap.chats)[0];
        if (first) setOutChatId(asText(first.chatId));
      }, [asList(snap.chats).length, outChatId]);

      const onInbound = function onInbound() {
        setSending(true);
        setInboundNote('');
        setInboundErr('');
        postJson(ROUTES.console, { action: 'inbound', chatId: chatId, text: text, wake: wake }).then(function done(result) {
          setSending(false);
          if (result.ok) {
            setInboundNote(wake ? T('console.inbound.okWake') : T('console.inbound.ok', { seq: result.detail || '' }));
            props.onRefresh();
          } else {
            setInboundErr(describeFailure(result) + (result.detail ? ' · ' + asText(result.detail) : ''));
          }
        });
      };

      const onOutbound = function onOutbound() {
        setOutSending(true);
        setOutNote('');
        setOutErr('');
        postJson(ROUTES.console, { action: 'outbound', chatId: outChatId, text: outText }).then(function done(result) {
          setOutSending(false);
          if (result.ok) {
            setOutNote(T('console.outbound.ok') + (result.detail && result.detail !== 'sent' ? ' · ' + asText(result.detail) : ''));
            props.onRefresh();
          } else {
            setOutErr(describeFailure(result) + (result.detail ? ' · ' + asText(result.detail) : ''));
          }
        });
      };

      const onStub = function onStub(start) {
        setStubBusy(true);
        setStubErr('');
        postJson(ROUTES.console, start ? { action: 'stub-start', port: Number(port) || STUB_PORT_FALLBACK } : { action: 'stub-stop' })
          .then(function done(result) {
            setStubBusy(false);
            if (result.ok) props.onRefresh();
            else setStubErr(describeFailure(result));
          });
      };

      const onReset = function onReset() {
        const confirmed = typeof globalThis.confirm === 'function' ? globalThis.confirm(T('console.reset.confirm')) : true;
        if (!confirmed) return;
        setResetBusy(true);
        postJson(ROUTES.reset, {}).then(function done(result) {
          setResetBusy(false);
          if (result.ok) {
            setResetNote(T('console.reset.done', { count: Number(result.chats) || 0 }));
            props.onRefresh();
          } else {
            setResetNote(describeFailure(result));
          }
        });
      };

      const stubUrl = '127.0.0.1:' + (Number(stub.port) > 0 ? Number(stub.port) : STUB_PORT_FALLBACK) + '/send';

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        h(Card, { delay: 0 },
          h(CardHead, { title: T('console.title'), sub: T('console.subtitle') })),

        h('div', { className: 'wx-split' },
          h(Card, { delay: 40 },
            h(CardHead, { title: T('console.inbound.title'), sub: T('console.inbound.desc') }),
            h('div', { className: 'wx-form' },
              h(Field, { label: T('console.inbound.chatId'), hint: T('console.inbound.chatIdHint') },
                h('input', {
                  className: 'wx-input wx-mono',
                  value: chatId,
                  onChange: function change(event) { setChatId(event.target.value); },
                  placeholder: 'test-user',
                })),
              h(Field, { label: T('console.inbound.text') },
                h('textarea', {
                  className: 'wx-textarea',
                  value: text,
                  onChange: function change(event) { setText(event.target.value); },
                  rows: 3,
                })),
              h(Field, { label: T('console.inbound.wake'), hint: T('console.inbound.wakeHint') },
                h(Toggle, { checked: wake, onChange: setWake, label: T('console.inbound.wake') }))),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', marginTop: '12px', flexWrap: 'wrap' } },
              h(Btn, {
                variant: 'primary',
                icon: 'bolt',
                disabled: sending || text.trim() === '',
                onClick: onInbound,
              }, sending ? T('console.inbound.sending') : T('console.inbound.submit')),
              inboundNote ? h('span', { className: 'wx-ok-line', style: { marginTop: 0 } }, inboundNote) : null,
              inboundErr ? h('span', { className: 'wx-error-line', style: { marginTop: 0 } }, inboundErr) : null)),

          h(Card, { delay: 80 },
            h(CardHead, { title: T('console.outbound.title'), sub: T('console.outbound.desc') }),
            h('div', { className: 'wx-form' },
              h(Field, { label: T('console.inbound.chatId'), hint: T('console.inbound.chatIdHint') },
                asList(snap.chats).length > 0
                  ? h('select', {
                      className: 'wx-select wx-mono',
                      value: outChatId,
                      onChange: function change(event) { setOutChatId(event.target.value); },
                    }, asList(snap.chats).map(function option(chat) {
                      const value = asText(chat.chatId);
                      return h('option', { key: value, value: value }, asText(chat.name) || value);
                    }))
                  : h('input', {
                      className: 'wx-input wx-mono',
                      value: outChatId,
                      onChange: function change(event) { setOutChatId(event.target.value); },
                      placeholder: 'test-user',
                    })),
              h(Field, { label: T('console.outbound.text') },
                h('textarea', {
                  className: 'wx-textarea',
                  value: outText,
                  onChange: function change(event) { setOutText(event.target.value); },
                  rows: 2,
                }))),
            gateway.sendUrl
              ? h('div', { style: { marginTop: '10px' } },
                  h('div', { className: 'wx-field-hint', style: { marginBottom: '4px' } }, T('field.sendUrl')),
                  h(CopyInline, { value: gateway.sendUrl }))
              : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', marginTop: '12px', flexWrap: 'wrap' } },
              h(Btn, {
                variant: 'primary',
                icon: 'play',
                disabled: outSending || outChatId.trim() === '' || outText.trim() === '',
                onClick: onOutbound,
              }, outSending ? T('console.outbound.sending') : T('console.outbound.submit')),
              outNote ? h('span', { className: 'wx-ok-line', style: { marginTop: 0 } }, outNote) : null,
              outErr ? h('span', { className: 'wx-error-line', style: { marginTop: 0 } }, outErr) : null))),

        h('div', { className: 'wx-split' },
          h(Card, { delay: 120 },
            h(CardHead, {
              title: T('console.stub.title'),
              sub: T('console.stub.desc'),
              side: h(Pill, { tone: stub.running ? 'on' : undefined },
                stub.running ? T('console.stub.on', { port: stub.port }) : T('console.stub.off')),
            }),
            h('div', { className: 'wx-form' },
              h(Field, { label: T('console.stub.port') },
                h('input', {
                  className: 'wx-input wx-mono',
                  value: port,
                  inputMode: 'numeric',
                  onChange: function change(event) { setPort(event.target.value.replace(/[^0-9]/g, '')); },
                }))),
            h('div', { style: { marginTop: '8px' } },
              h('div', { className: 'wx-field-hint', style: { marginBottom: '4px' } }, T('console.stub.addr')),
              h(CopyInline, { value: stubUrl })),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
              stub.running
                ? h(Btn, { icon: 'stop', disabled: stubBusy, onClick: function stop() { onStub(false); } }, T('console.stub.stop'))
                : h(Btn, { variant: 'primary', icon: 'play', disabled: stubBusy, onClick: function start() { onStub(true); } }, T('console.stub.start'))),
            stubErr ? h('div', { className: 'wx-error-line' }, stubErr) : null,
            asList(stub.received).length > 0
              ? h('div', { className: 'wx-rows', style: { marginTop: '12px' } }, asList(stub.received).slice(0, 6).map(function render(item, index) {
                  return h('div', { key: 'st' + index, className: 'wx-row' },
                    h('span', { className: 'wx-row-time' }, formatClock(Number(item.at))),
                    h('span', { className: 'wx-row-dot wx-row-dot--ok', 'aria-hidden': 'true' }),
                    h('div', { className: 'wx-row-body' },
                      h('div', { className: 'wx-row-main wx-mono' }, truncate(asText(item.text), 160))));
                }))
              : null),

          h(Card, { delay: 160 },
            h(CardHead, { title: T('console.reset.title'), sub: T('console.reset.desc') }),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h(Btn, { variant: 'danger', icon: 'alert', disabled: resetBusy, onClick: onReset }, T('console.reset.action')),
              resetNote ? h('span', { className: 'wx-muted', style: { fontSize: '11.5px' } }, resetNote) : null))));
    }

    /* ═════════════════════════════ 设置 ═════════════════════════════ */

    /** 从快照取字段初值（点路径 → 表单字符串/布尔）。 */
    function seedDraft(snap) {
      const config = isRecord(snap.config) ? snap.config : {};
      const gateway = isRecord(config.gateway) ? config.gateway : {};
      const reply = {
        autoReply: Boolean(snap.autoReply),
        mode: asText(config.mode) === 'formatted' ? 'formatted' : 'raw',
        prefix: asText(config.prefix),
        suffix: asText(config.suffix),
        maxReplyChars: String(Number(config.maxReplyChars) || 1800),
        fallbackText: asText(config.fallbackText),
        idleSessionMs: String(Number(config.idleSessionMs) || 1800000),
        agentPreset: asText(config.agentPreset),
        fallbackPreset: asText(config.fallbackPreset),
        allowedChatIds: joinList(config.allowedChatIds),
        selfNames: joinList(config.selfNames),
      };
      const tap = {
        kind: asText(config.kind) || 'generic',
        sendUrl: asText(gateway.sendUrl),
        sharedSecret: '',
        appId: asText(gateway.appId),
        appSecret: '',
        token: '',
        wecomWebhook: '',
        debug: Boolean(config.debug),
      };
      return { reply: reply, gateway: tap };
    }

    function SettingsTab(props) {
      const snap = props.snapshot;
      const config = isRecord(snap.config) ? snap.config : {};
      const gatewayConfig = isRecord(config.gateway) ? config.gateway : {};
      const presets = asList(snap.presets);
      const override = isRecord(snap.override) ? snap.override : {};
      const overrideCount = Object.keys(override).length;

      const [draft, setDraft] = React.useState(function initial() { return seedDraft(snap); });
      const [dirty, setDirty] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [note, setNote] = React.useState('');
      const [err, setErr] = React.useState('');
      const dirtyCount = Object.keys(dirty).length;

      /* 快照刷新时：没有未保存改动才重新播种，避免把用户正在打的东西冲掉。 */
      const configKey = JSON.stringify([config, snap.autoReply]);
      const lastKeyRef = React.useRef(configKey);
      const dirtyRef = React.useRef(dirty);
      dirtyRef.current = dirty;
      React.useEffect(function reseed() {
        if (lastKeyRef.current === configKey) return;
        lastKeyRef.current = configKey;
        if (Object.keys(dirtyRef.current).length > 0) return;
        setDraft(seedDraft(snap));
      }, [configKey]);

      const setField = function setField(group, key, value) {
        setDraft(function next(previous) {
          const branch = Object.assign({}, previous[group]);
          branch[key] = value;
          return Object.assign({}, previous, { [group]: branch });
        });
        setDirty(function next(previous) {
          const copy = Object.assign({}, previous);
          copy[group + '.' + key] = true;
          return copy;
        });
        setNote('');
        setErr('');
      };

      const discard = function discard() {
        setDraft(seedDraft(snap));
        setDirty({});
        setNote('');
        setErr('');
      };

      const save = function save() {
        if (dirtyCount === 0) return;
        const patch = {};
        const secretFields = { sharedSecret: true, appSecret: true, token: true };

        for (const path of Object.keys(dirty)) {
          const parts = path.split('.');
          const group = parts[0];
          const key = parts[1];
          const value = draft[group][key];
          if (secretFields[key] && asText(value).trim() === '') continue;

          if (group === 'reply') {
            if (key === 'autoReply') patch['reply.autoReply'] = Boolean(value);
            else if (key === 'maxReplyChars') patch['reply.maxReplyChars'] = Math.max(1, Number(value) || 1800);
            else if (key === 'idleSessionMs') patch['reply.idleSessionMs'] = Math.max(0, Number(value) || 0);
            else if (key === 'allowedChatIds') patch['reply.allowedChatIds'] = splitList(value);
            else if (key === 'selfNames') patch['reply.selfNames'] = splitList(value);
            else patch['reply.' + key] = asText(value);
            continue;
          }
          if (key === 'debug') {
            patch.debug = Boolean(value);
            continue;
          }
          if (key === 'kind') {
            patch.kind = asText(value);
            continue;
          }
          patch['gateway.' + key] = asText(value);
        }

        setSaving(true);
        setNote('');
        setErr('');
        putJson(ROUTES.config, { config: patch }).then(function done(result) {
          setSaving(false);
          if (!result.ok) {
            setErr(describeFailure(result));
            return;
          }
          const applied = asList(result.applied).length;
          const restart = asList(result.restart).length;
          setNote(restart > 0
            ? T('settings.savedRestart', { count: restart })
            : T('settings.saved', { count: applied }));
          setDirty({});
          setDraft(function clearSecrets(previous) {
            const next = seedDraft(snap);
            next.reply = Object.assign({}, previous.reply);
            next.gateway = Object.assign({}, previous.gateway, { sharedSecret: '', appSecret: '', token: '' });
            return next;
          });
          if (typeof props.onSaved === 'function') props.onSaved();
        });
      };

      const resetOverride = function resetOverride() {
        setSaving(true);
        putJson(ROUTES.config, { action: 'reset' }).then(function done(result) {
          setSaving(false);
          if (result.ok) {
            setNote(T('settings.resetOverrideDone'));
            setDirty({});
            if (typeof props.onSaved === 'function') props.onSaved();
          } else {
            setErr(describeFailure(result));
          }
        });
      };

      const presetOptions = [];
      const knownPresets = {};
      for (const preset of presets) {
        const id = asText(preset.id);
        if (id === '') continue;
        knownPresets[id] = true;
        presetOptions.push({ id: id, label: asText(preset.name) || id, broken: Boolean(preset.broken) });
      }
      const draftPreset = asText(draft.reply.agentPreset);
      if (draftPreset !== '' && !knownPresets[draftPreset]) {
        presetOptions.unshift({ id: draftPreset, label: draftPreset + ' · ' + T('health.agent.off'), broken: true });
      }

      const kindOptions = [
        { id: 'generic', label: T('field.kind.generic') },
        { id: 'official', label: T('field.kind.official') },
        { id: 'wecom', label: T('field.kind.wecom') },
      ];

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        h(Card, { delay: 0 },
          h(CardHead, {
            title: T('settings.title'),
            sub: T('settings.subtitle'),
            side: h('span', { className: 'wx-muted', style: { fontSize: '11.5px' } },
              overrideCount > 0 ? T('settings.override', { count: overrideCount }) : T('settings.overrideNone')),
          })),

        h(Card, { delay: 40 },
          h(CardHead, { title: T('settings.group.reply') }),
          h('div', { className: 'wx-form' },
            h(Field, { label: T('field.autoReply'), hint: T('field.autoReplyHint') },
              h(Toggle, {
                checked: Boolean(draft.reply.autoReply),
                onChange: function change(value) { setField('reply', 'autoReply', value); },
                label: draft.reply.autoReply ? 'ON' : 'OFF',
              })),

            h(Field, { label: T('field.mode'), hint: T('field.modeHint') },
              h('select', {
                className: 'wx-select',
                value: draft.reply.mode,
                onChange: function change(event) { setField('reply', 'mode', event.target.value); },
              },
                h('option', { value: 'raw' }, T('field.mode.raw')),
                h('option', { value: 'formatted' }, T('field.mode.formatted')))),

            h(Field, { label: T('field.prefix'), hint: T('field.prefixHint') },
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
                h('input', {
                  className: 'wx-input',
                  value: draft.reply.prefix,
                  placeholder: T('field.prefix'),
                  onChange: function change(event) { setField('reply', 'prefix', event.target.value); },
                }),
                h('input', {
                  className: 'wx-input',
                  value: draft.reply.suffix,
                  placeholder: T('field.suffix'),
                  onChange: function change(event) { setField('reply', 'suffix', event.target.value); },
                }))),

            h(Field, { label: T('field.agentPreset'), hint: T('field.agentPresetHint') },
              presetOptions.length > 0
                ? h('select', {
                    className: 'wx-select',
                    value: draft.reply.agentPreset,
                    onChange: function change(event) { setField('reply', 'agentPreset', event.target.value); },
                  }, presetOptions.map(function option(preset) {
                    return h('option', { key: preset.id, value: preset.id }, preset.label);
                  }))
                : h('input', {
                    className: 'wx-input wx-mono',
                    value: draft.reply.agentPreset,
                    onChange: function change(event) { setField('reply', 'agentPreset', event.target.value); },
                  })),

            h(Field, { label: T('field.fallbackPreset'), hint: T('field.fallbackPresetHint') },
              h('input', {
                className: 'wx-input wx-mono',
                value: draft.reply.fallbackPreset,
                placeholder: T('common.none'),
                onChange: function change(event) { setField('reply', 'fallbackPreset', event.target.value); },
              })),

            h(Field, { label: T('field.maxReplyChars'), hint: T('field.maxReplyCharsHint') },
              h('input', {
                className: 'wx-input wx-mono',
                inputMode: 'numeric',
                value: draft.reply.maxReplyChars,
                onChange: function change(event) { setField('reply', 'maxReplyChars', event.target.value.replace(/[^0-9]/g, '')); },
              })),

            h(Field, { label: T('field.fallbackText'), hint: T('field.fallbackTextHint') },
              h('textarea', {
                className: 'wx-textarea',
                rows: 2,
                value: draft.reply.fallbackText,
                onChange: function change(event) { setField('reply', 'fallbackText', event.target.value); },
              })),

            h(Field, { label: T('field.idleSessionMs'), hint: T('field.idleSessionMsHint') },
              h('input', {
                className: 'wx-input wx-mono',
                inputMode: 'numeric',
                value: draft.reply.idleSessionMs,
                onChange: function change(event) { setField('reply', 'idleSessionMs', event.target.value.replace(/[^0-9]/g, '')); },
              })))),

        h(Card, { delay: 80 },
          h(CardHead, { title: T('settings.group.gateway') }),
          h('div', { className: 'wx-form' },
            h(Field, { label: T('field.kind'), hint: T('field.kindHint') },
              h('select', {
                className: 'wx-select',
                value: draft.gateway.kind,
                onChange: function change(event) { setField('gateway', 'kind', event.target.value); },
              }, kindOptions.map(function option(item) {
                return h('option', { key: item.id, value: item.id }, item.label);
              }))),

            h(Field, {
              label: T('field.sendUrl'),
              hint: T('field.sendUrlHint'),
            },
              h('input', {
                className: 'wx-input wx-mono',
                value: draft.gateway.sendUrl,
                placeholder: 'http://127.0.0.1:8787/send',
                onChange: function change(event) { setField('gateway', 'sendUrl', event.target.value); },
              })),

            h(Field, { label: T('field.sharedSecret'), hint: T('field.sharedSecretHint') },
              h('input', {
                className: 'wx-input wx-mono',
                type: 'password',
                autoComplete: 'off',
                value: draft.gateway.sharedSecret,
                placeholder: gatewayConfig.sharedSecretSet ? T('field.secretPlaceholder') : T('field.secretEmpty'),
                onChange: function change(event) { setField('gateway', 'sharedSecret', event.target.value); },
              })),

            draft.gateway.kind === 'official'
              ? h('div', null,
                  h(Field, { label: T('field.appId'), hint: T('field.officialHint') },
                    h('input', {
                      className: 'wx-input wx-mono',
                      value: draft.gateway.appId,
                      onChange: function change(event) { setField('gateway', 'appId', event.target.value); },
                    })),
                  h(Field, { label: T('field.appSecret') },
                    h('input', {
                      className: 'wx-input wx-mono',
                      type: 'password',
                      autoComplete: 'off',
                      value: draft.gateway.appSecret,
                      placeholder: gatewayConfig.appSecretSet ? T('field.secretPlaceholder') : T('field.secretEmpty'),
                      onChange: function change(event) { setField('gateway', 'appSecret', event.target.value); },
                    })),
                  h(Field, { label: T('field.token') },
                    h('input', {
                      className: 'wx-input wx-mono',
                      type: 'password',
                      autoComplete: 'off',
                      value: draft.gateway.token,
                      placeholder: gatewayConfig.tokenSet ? T('field.secretPlaceholder') : T('field.secretEmpty'),
                      onChange: function change(event) { setField('gateway', 'token', event.target.value); },
                    })))
              : null,

            draft.gateway.kind === 'wecom'
              ? h(Field, { label: T('field.wecomWebhook'), hint: T('field.wecomHint') },
                  h('input', {
                    className: 'wx-input wx-mono',
                    value: draft.gateway.wecomWebhook,
                    placeholder: gatewayConfig.wecom ? T('field.secretPlaceholder') : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
                    onChange: function change(event) { setField('gateway', 'wecomWebhook', event.target.value); },
                  }))
              : null,

            h(Field, { label: T('field.webhookPath'), hint: T('field.webhookPathHint'), badge: true },
              h(CopyInline, { value: asText(config.webhookPath) })),

            h(Field, { label: T('field.debug'), hint: T('field.debugHint') },
              h(Toggle, {
                checked: Boolean(draft.gateway.debug),
                onChange: function change(value) { setField('gateway', 'debug', value); },
                label: draft.gateway.debug ? 'ON' : 'OFF',
              })))),

        h(Card, { delay: 120 },
          h(CardHead, { title: T('settings.group.scope') }),
          h('div', { className: 'wx-form' },
            h(Field, { label: T('field.allowedChatIds'), hint: T('field.allowedChatIdsHint') },
              h('textarea', {
                className: 'wx-textarea wx-mono',
                rows: 3,
                value: draft.reply.allowedChatIds,
                placeholder: 'wechat-test\n123456@chatroom',
                onChange: function change(event) { setField('reply', 'allowedChatIds', event.target.value); },
              })),
            h(Field, { label: T('field.selfNames'), hint: T('field.selfNamesHint') },
              h('textarea', {
                className: 'wx-textarea wx-mono',
                rows: 2,
                value: draft.reply.selfNames,
                onChange: function change(event) { setField('reply', 'selfNames', event.target.value); },
              })))),

        err !== '' ? h('div', { className: 'wx-notice wx-notice--err' }, err) : null,

        h('div', { className: 'wx-savebar' },
          h('span', { className: 'wx-muted', style: { fontSize: '11.5px' } },
            dirtyCount > 0 ? T('settings.dirty', { count: dirtyCount }) : (note || T('settings.clean'))),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            overrideCount > 0
              ? h(Btn, { small: true, variant: 'quiet', disabled: saving, onClick: resetOverride }, T('settings.resetOverride'))
              : null,
            h(Btn, { small: true, variant: 'quiet', disabled: saving || dirtyCount === 0, onClick: discard }, T('settings.discard')),
            h(Btn, {
              small: true,
              variant: 'primary',
              icon: 'check',
              disabled: saving || dirtyCount === 0,
              onClick: save,
            }, saving ? T('settings.saving') : T('settings.save')))));
    }

    /* ═════════════════════════════ 体检 ═════════════════════════════ */

    function CheckTab(props) {
      const [result, setResult] = React.useState(null);
      const [running, setRunning] = React.useState(false);
      const [err, setErr] = React.useState('');

      const run = function run() {
        setRunning(true);
        setErr('');
        postJson(ROUTES.selftest, {}).then(function done(payload) {
          setRunning(false);
          if (isRecord(payload) && Array.isArray(payload.checks)) {
            setResult(payload);
            if (typeof props.onRefresh === 'function') props.onRefresh();
          } else {
            setErr(describeFailure(payload));
          }
        });
      };

      const checks = result !== null ? asList(result.checks) : [];
      const summary = result !== null && isRecord(result.summary) ? result.summary : {};
      const passed = Number(summary.passed) || 0;
      const total = Number(summary.total) || checks.length;

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
        h(Card, { delay: 0 },
          h(CardHead, {
            title: T('check.title'),
            sub: T('check.subtitle'),
            side: h(Btn, {
              variant: 'primary',
              icon: 'shield',
              disabled: running,
              onClick: run,
            }, running ? T('check.running') : T('check.run')),
          }),
          total > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h(Meter, { value: passed, total: total }),
                h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: '12px', fontWeight: 550 } },
                    passed === total ? T('check.allOk') : T('check.summaryFail', { failed: total - passed })),
                  h('span', { className: 'wx-muted', style: { fontSize: '11px' } },
                    T('check.ranAt', { time: formatClock(Number(result.ranAt)) }))))
            : null),
        err !== '' ? h('div', { className: 'wx-notice wx-notice--err' }, err) : null,

        h(Card, { delay: 40 },
          checks.length === 0
            ? h(Empty, null, running ? T('check.running') : T('check.empty'))
            : h('div', null, checks.map(function render(check, index) {
                const level = asText(check.level) === 'error' ? 'error' : asText(check.level) === 'warn' ? 'warn' : 'ok';
                return h('div', {
                  key: asText(check.id) || 'c' + index,
                  className: 'wx-check-row wx-fade',
                  style: { animationDelay: (30 + index * 40) + 'ms' },
                },
                  h('span', { className: 'wx-check-mark wx-check-mark--' + level, 'aria-hidden': 'true' },
                    level === 'ok' ? h(Icon, { name: 'check', size: 10, bold: true }) : (level === 'warn' ? '!' : '×')),
                  h('div', { className: 'wx-check-body' },
                    h('div', { className: 'wx-check-title' }, asText(check.title) || T('common.dash')),
                    asText(check.detail) ? h('div', { className: 'wx-check-detail' }, asText(check.detail)) : null,
                    asText(check.fix) ? h('div', { className: 'wx-check-fix' }, T('check.fix', { fix: asText(check.fix) })) : null));
              }))));
    }

    /* ═════════════════════════════ 主面板 ═════════════════════════════ */

    function WeChatPanel() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [tab, setTab] = React.useState('overview');
      const [updatedAt, setUpdatedAt] = React.useState(0);
      const [reloadTick, setReloadTick] = React.useState(0);
      const [localeRevision, setLocaleRevision] = React.useState(0);
      const [wizard, setWizard] = React.useState({
        step: 'stub', busy: false, error: '', completed: false,
        done: { stub: false, point: false, ping: false },
      });
      const aliveRef = React.useRef(true);
      const markRef = React.useRef(null);
      const tabsRef = React.useRef(null);

      const requestRefresh = React.useCallback(function requestRefresh() {
        setReloadTick(function bump(value) { return value + 1; });
      }, []);

      /* 活/死标记：异步动作回来后不再 setState。 */
      React.useEffect(function trackMount() {
        aliveRef.current = true;
        return function markDead() { aliveRef.current = false; };
      }, []);

      /* 语言切换时重渲染（词典在 apply 里注册）。 */
      React.useEffect(function followLocale() {
        if (typeof subscribeLocale !== 'function') return undefined;
        return subscribeLocale(function onLocaleChange() {
          setLocaleRevision(function bump(revision) { return revision + 1; });
        });
      }, []);

      /* 轮询：只在挂载期间；失败保留上一份快照。 */
      React.useEffect(function poll() {
        let disposed = false;
        let controller = null;
        function load() {
          if (controller !== null) {
            try { controller.abort(); } catch (error) { /* ignore */ }
          }
          controller = typeof AbortController === 'function' ? new AbortController() : null;
          const signal = controller === null ? undefined : controller.signal;
          getJson(ROUTES.state, signal).then(function apply(result) {
            if (disposed || result.aborted) return;
            if (result.ok) {
              setSnapshot(result.data);
              setFailure(null);
              setUpdatedAt(Date.now());
            } else {
              setFailure(result);
            }
          });
        }
        load();
        const timer = globalThis.setInterval(load, POLL_MS);
        return function stop() {
          disposed = true;
          globalThis.clearInterval(timer);
          if (controller !== null) {
            try { controller.abort(); } catch (error) { /* ignore */ }
          }
        };
      }, [reloadTick]);

      /* 标签指示条：量一下当前按钮，位移过去。 */
      React.useEffect(function moveIndicator() {
        const container = tabsRef.current;
        if (!container) return;
        const buttons = container.querySelectorAll('[data-wx-tab]');
        let target = null;
        for (let index = 0; index < buttons.length; index++) {
          if (buttons[index].getAttribute('data-wx-tab') === tab) target = buttons[index];
        }
        if (!target || !markRef.current) return;
        const box = container.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        const mark = markRef.current;
        mark.style.width = Math.max(0, rect.width) + 'px';
        mark.style.transform = 'translateX(' + Math.max(0, rect.left - box.left - 3) + 'px)';
      }, [tab, localeRevision]);

      /* 窗口尺寸变化时重新对齐。 */
      React.useEffect(function realignOnResize() {
        if (typeof globalThis.addEventListener !== 'function') return undefined;
        const onResize = function onResize() {
          setLocaleRevision(function bump(value) { return value + 1; });
        };
        globalThis.addEventListener('resize', onResize);
        return function off() { globalThis.removeEventListener('resize', onResize); };
      }, []);

      /* ── 三步向导动作 ── */
      const runStubStart = function runStubStart() {
        setWizard(function busy(previous) { return Object.assign({}, previous, { busy: true, error: '' }); });
        postJson(ROUTES.console, { action: 'stub-start', port: STUB_PORT_FALLBACK }).then(function done(result) {
          if (!aliveRef.current) return;
          if (!result.ok) {
            setWizard(function fail(previous) {
              return Object.assign({}, previous, { busy: false, error: describeFailure(result) });
            });
            return;
          }
          setWizard(function next(previous) {
            return Object.assign({}, previous, {
              busy: false, step: 'point', error: '',
              done: Object.assign({}, previous.done, { stub: true }),
            });
          });
          requestRefresh();
          const wizardSnapshot = { stubPort: result.port };
          /* 起好了就顺手把它写进配置：少一次点击，路径也就不会打错。 */
          const url = 'http://127.0.0.1:' + wizardSnapshot.stubPort + '/send';
          putJson(ROUTES.config, { config: { 'gateway.sendUrl': url } }).then(function pointed(configResult) {
            if (!aliveRef.current) return;
            setWizard(function next2(previous) {
              if (!configResult.ok) {
                return Object.assign({}, previous, { error: describeFailure(configResult) });
              }
              return Object.assign({}, previous, {
                step: 'ping',
                done: Object.assign({}, previous.done, { point: true }),
              });
            });
            requestRefresh();
          });
        });
      };

      const runPointAtStub = function runPointAtStub(url) {
        setWizard(function busy(previous) { return Object.assign({}, previous, { busy: true, error: '' }); });
        putJson(ROUTES.config, { config: { 'gateway.sendUrl': url } }).then(function done(result) {
          if (!aliveRef.current) return;
          if (!result.ok) {
            setWizard(function fail(previous) {
              return Object.assign({}, previous, { busy: false, error: describeFailure(result) });
            });
            return;
          }
          setWizard(function next(previous) {
            return Object.assign({}, previous, {
              busy: false, step: 'ping', error: '',
              done: Object.assign({}, previous.done, { point: true }),
            });
          });
          requestRefresh();
        });
      };

      const runPing = function runPing() {
        setWizard(function busy(previous) { return Object.assign({}, previous, { busy: true, error: '' }); });
        postJson(ROUTES.console, {
          action: 'outbound',
          chatId: 'wechat-test',
          text: T('wizard.ping.text'),
        }).then(function done(result) {
          if (!aliveRef.current) return;
          setWizard(function next(previous) {
            if (!result.ok) {
              return Object.assign({}, previous, { busy: false, error: describeFailure(result) });
            }
            return Object.assign({}, previous, {
              busy: false, error: '', completed: true,
              done: Object.assign({}, previous.done, { ping: true }),
            });
          });
          requestRefresh();
        });
      };

      const runWizardReset = function runWizardReset() {
        setWizard({ step: 'stub', busy: false, error: '', completed: false, done: { stub: false, point: false, ping: false } });
      };

      const runStubStop = function runStubStop() {
        postJson(ROUTES.console, { action: 'stub-stop' }).then(function done() {
          if (!aliveRef.current) return;
          runWizardReset();
          requestRefresh();
        });
      };

      /* ── 渲染 ── */

      if (snapshot === null) {
        const missing = failure !== null && failure.kind === 'missing';
        return h('div', { className: 'wx-page' },
          h('div', { className: 'wx-card wx-fade', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } },
              h(Icon, { name: missing ? 'alert' : 'clock', size: 15 }),
              h('h2', { className: 'wx-title' }, missing ? T('host.missingTitle') : T('host.loading'))),
            h('p', { className: 'wx-sub', style: { margin: 0 } },
              missing ? T('host.missingBody') : T('host.unreachable')),
            failure !== null && failure.message
              ? h('p', { className: 'wx-error-line', style: { margin: 0 } }, failure.message)
              : null,
            h('div', null,
              h(Btn, { small: true, icon: 'refresh', onClick: requestRefresh }, T('host.retry')))));
      }

      const snap = snapshot;
      const config = isRecord(snap.config) ? snap.config : {};
      const chats = asList(snap.chats);
      const unreadTotal = chats.reduce(function sum(total, chat) { return total + (Number(chat.unread) || 0); }, 0);
      const live = Boolean(snap.autoReply !== false && config.webhookPath);

      const tabButtons = TABS.map(function build(item) {
        const on = item.id === tab;
        let badge = null;
        if (item.id === 'chats' && unreadTotal > 0) badge = h('span', { className: 'wx-tab-badge' }, unreadTotal > 99 ? '99+' : unreadTotal);
        return h('button', {
          key: item.id,
          type: 'button',
          className: 'wx-tab' + (on ? ' wx-tab--on' : ''),
          'data-wx-tab': item.id,
          onClick: function select() { setTab(item.id); },
          'aria-current': on ? 'page' : undefined,
        },
          h(Icon, { name: item.icon, size: 13, bold: on }),
          T(item.label),
          badge);
      });

      let body = null;
      if (tab === 'overview') {
        body = h(OverviewTab, {
          snapshot: snap,
          wizard: wizard,
          onStubStart: runStubStart,
          onPointAtStub: runPointAtStub,
          onPing: runPing,
          onWizardReset: runWizardReset,
          onStubStop: runStubStop,
        });
      } else if (tab === 'chats') {
        body = h(ChatsTab, { snapshot: snap, tick: reloadTick, onRefresh: requestRefresh });
      } else if (tab === 'console') {
        body = h(ConsoleTab, { snapshot: snap, onRefresh: requestRefresh });
      } else if (tab === 'settings') {
        body = h(SettingsTab, { snapshot: snap, onSaved: requestRefresh });
      } else {
        body = h(CheckTab, { onRefresh: requestRefresh });
      }

      return h('div', { className: 'wx-page' },
        h('header', { className: 'wx-head wx-fade' },
          h('div', { className: 'wx-head-mark' }, h(Icon, { name: 'wechat', size: 20, bold: true })),
          h('div', { className: 'wx-head-text' },
            h('h1', null, T('panel.title')),
            h('p', null, T('panel.subtitle'))),
          h('div', { className: 'wx-head-side' },
            h(Pill, { tone: live ? 'on' : 'warn' }, live ? T('panel.badge.on') : T('panel.badge.off')),
            h(Btn, {
              small: true,
              variant: 'quiet',
              icon: 'refresh',
              onClick: requestRefresh,
              title: T('panel.refresh'),
            }, T('panel.refresh')))),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('div', { className: 'wx-tabs', ref: tabsRef, role: 'tablist' },
            h('span', { className: 'wx-tab-mark', ref: markRef, 'aria-hidden': 'true' }),
            tabButtons),
          h('span', { style: { flex: 1 } }),
          h('span', { className: 'wx-muted', style: { fontSize: '11px' } },
            failure !== null
              ? T('panel.stale', { time: formatClock(updatedAt) })
              : T('panel.updated', { time: formatClock(updatedAt) }))),

        failure !== null && failure.kind !== 'missing'
          ? h('div', { className: 'wx-notice wx-notice--err' }, describeFailure(failure))
          : null,

        body,

        h('footer', { className: 'wx-muted', style: { fontSize: '11px', display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          h('span', null, T('stat.uptime', { duration: formatDuration(isRecord(snap.plugin) ? snap.plugin.uptimeMs : 0) })),
          h('span', null, '·'),
          h('span', { className: 'wx-mono' }, asText(config.webhookPath)),
          h('span', null, '·'),
          h('span', null, isRecord(snap.plugin) ? asText(snap.plugin.name) : '')));
    }

    /** 侧栏入口图标。 */
    function WeChatIcon(props) {
      const size = Number.isFinite(props && props.size) && props.size > 0 ? props.size : 16;
      const active = Boolean(props && props.active);
      return h('svg', {
        'data-dsh-panel-entry': 'wechat',
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.5 : 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M12.8 7.9c0 2-1.9 3.7-4.2 3.7-.6 0-1.1-.1-1.6-.2L4.1 12.4l.7-1.9C3.6 9.9 3 8.9 3 7.9c0-2 1.9-3.7 4.2-3.7s5.6 1.7 5.6 3.7Z' }),
        h('path', { d: 'M6.2 7.3h.01' }),
        h('path', { d: 'M9.4 7.3h.01' }),
        h('path', { d: 'M13.2 10.4c1 .5 1.6 1.3 1.6 2.2 0 .8-.5 1.5-1.3 2l.4 1.2-1.6-.8c-.4.1-.9.1-1.3.1-.9 0-1.7-.2-2.3-.6' }));
    }

    /* ═════════════════════════════ 注册 ═════════════════════════════ */

    /* 只读导出：给 scripts/verify-client.mjs 做 SSR 冒烟测试用，不认识也无害。 */
    const __internals = Object.freeze({
      OverviewTab, ChatsTab, ConsoleTab, SettingsTab, CheckTab, WeChatPanel, WeChatIcon,
      dictionaries: Object.freeze({ zh: ZH, en: EN }),
      tabs: TABS, wizardSteps: WIZARD_STEPS,
    });

    return {
      inject: ['slots', 'locale'],
      __internals,
      apply(ctx) {
        /* 词典先注册：侧栏行标签和页面都靠 t。 */
        ctx.effect(function registerDictionaries() {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, 'wechat-bridge: dictionaries');

        const t = ctx.locale.bind(NS);
        translate = t;
        if (ctx.locale && typeof ctx.locale.subscribe === 'function') {
          subscribeLocale = function subscribeLocaleChange(listener) {
            return ctx.locale.subscribe(listener);
          };
        }

        /* 样式：一个 <style>，卸载时移除。 */
        ctx.effect(function registerStyles() {
          if (typeof document === 'undefined') return function noop() {};
          const existing = document.getElementById(STYLE_ID);
          if (existing) return function keep() {};
          const element = document.createElement('style');
          element.id = STYLE_ID;
          element.textContent = CSS;
          document.head.appendChild(element);
          return function removeStyle() {
            if (element.parentNode) element.parentNode.removeChild(element);
          };
        }, 'wechat-bridge: styles');

        /* 两个座位都由别的 shell 插件提供，所以各自走 slots.inject；清理器收在一个 effect 里。 */
        ctx.effect(function registerPanelSeats() {
          const disposers = [];
          disposers.push(ctx.slots.inject('sidebar.panellist', function registerSidebarRow() {
            return ctx.slots.register({
              name: 'sidebar.panellist',
              id: 'wechat',
              order: 25,
              label: function panelLabel() { return t('entry.label'); },
            }, WeChatIcon);
          }));
          disposers.push(ctx.slots.inject('main', function registerMainPage() {
            return ctx.slots.register({
              name: 'main',
              key: 'wechat',
            }, WeChatPanel);
          }));
          return function disposeSeats() {
            for (const dispose of disposers.splice(0)) {
              try {
                if (typeof dispose === 'function') dispose();
              } catch (error) {
                console.warn('[wechat-bridge] slot disposal failed:', error);
              }
            }
          };
        }, 'wechat-bridge: panel seats');
      },
    };







  },
});
