/** The Privacy settings section's copy. */

/** English dictionary. */
export const en = {
  'notice.title': 'Preview',
  'notice.body': 'Delo is a pre-release community fork of DeepSeek Harness. It is built and maintained by Delo Run, independently of DeepSeek, and it is still in preview: many areas need continued improvement.\n\nThe first release has no DeepSeek account sign-in, and Delo has no telemetry of its own. Your model provider and your own API key work as before. Report problems and suggestions on Delo\'s GitHub issues page.',
  'notice.continue': 'Continue',
  'nav': 'Privacy',
  'title': 'Privacy',
  'statement.delo': 'Delo has no telemetry of its own.',
  'statement.optIns': 'DeepSeek Harness\'s desktop analytics and DeepSeek\'s session-log upload are off unless you turn them on. You can turn them on later in Settings → Privacy.',
  'statement.feedback': 'Sending feedback includes a session-log prefix, and it is sent only when you send feedback.',
  'sessionLog.title': 'DeepSeek session-log upload',
  'sessionLog.description': 'Requests to DeepSeek\'s official model API also carry the part of the chat\'s session log not sent yet.',
  'sessionLog.confirm.title': 'Turn on DeepSeek session-log upload?',
  'sessionLog.confirm.body': 'From your next message, each request to DeepSeek\'s official model API, or to the gateway configured in its place, also carries the part of the chat\'s session log not sent yet: your messages, the replies, tool calls with their results, workspace paths and feedback. That includes what the chat recorded while upload was off. Turning it off in Settings → Privacy stops further uploads; what was sent stays with DeepSeek.',
  'analytics.title': 'Desktop analytics',
  'analytics.description': 'The desktop app reports selected interactions to DeepSeek\'s analytics collector.',
  'analytics.unavailable': 'Only the desktop app collects these analytics, and this profile does not.',
  'analytics.confirm.title': 'Turn on desktop analytics?',
  'analytics.confirm.body': 'The desktop app will report selected interactions, such as sending a message, switching models and installing plugins, to DeepSeek\'s analytics collector, with your device and account identifiers, the app version and your system\'s details. Message contents and keys are not included. Turning it off in Settings → Privacy stops further reports.',
  'confirm.accept': 'Turn on',
  'confirm.cancel': 'Cancel',
  'confirm.close': 'Close',
  'failed': 'The setting was not saved, and it is unchanged.',
  'version.delo': 'Delo version: {version}',
  'version.dsh': 'DeepSeek Harness version: {version}',
}

/** A key of the section's dictionary. */
export type PrivacyLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: typeof en = {
  'notice.title': '预览版',
  'notice.body': 'Delo 是 DeepSeek Harness 的预发布社区分支，由 Delo Run 独立构建和维护，与 DeepSeek 无关。它仍处于预览阶段，许多方面需要持续改进。\n\n首个版本没有 DeepSeek 账户登录，Delo 也没有自己的遥测。你的模型提供方与你自己的 API 密钥照常可用。问题与建议请提交到 Delo 的 GitHub issues 页面。',
  'notice.continue': '继续',
  'nav': '隐私',
  'title': '隐私',
  'statement.delo': 'Delo 没有自己的遥测。',
  'statement.optIns': 'DeepSeek Harness 的桌面端分析与 DeepSeek 的会话日志上传默认关闭，只有你打开后才会生效。你之后可以在“设置 → 隐私”中打开。',
  'statement.feedback': '发送反馈时会附带会话日志的前缀部分，且只在你发送反馈时发送。',
  'sessionLog.title': 'DeepSeek 会话日志上传',
  'sessionLog.description': '发往 DeepSeek 官方模型 API 的请求会同时携带该对话尚未发送的会话日志部分。',
  'sessionLog.confirm.title': '打开 DeepSeek 会话日志上传？',
  'sessionLog.confirm.body': '从你的下一条消息起，每个发往 DeepSeek 官方模型 API（或代替它配置的网关）的请求都会同时携带该对话尚未发送的会话日志部分：你的消息、回复、工具调用及其结果、工作区路径和反馈，其中也包括上传关闭期间该对话记录的内容。在“设置 → 隐私”中关闭后将不再继续上传；已发送的内容仍保留在 DeepSeek。',
  'analytics.title': '桌面端分析',
  'analytics.description': '桌面应用会向 DeepSeek 的分析收集服务报告选定的交互。',
  'analytics.unavailable': '只有桌面应用会收集这些分析数据，当前 profile 不会收集。',
  'analytics.confirm.title': '打开桌面端分析？',
  'analytics.confirm.body': '桌面应用将向 DeepSeek 的分析收集服务报告选定的交互，例如发送消息、切换模型和安装插件，并附带你的设备与账号标识、应用版本和系统信息。不包含消息内容和密钥。在“设置 → 隐私”中关闭后将不再继续报告。',
  'confirm.accept': '打开',
  'confirm.cancel': '取消',
  'confirm.close': '关闭',
  'failed': '设置未保存，保持不变。',
  'version.delo': 'Delo 版本：{version}',
  'version.dsh': 'DeepSeek Harness 版本：{version}',
}
