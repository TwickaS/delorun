/**
 * The onboarding's copy, in English and Chinese.
 * @module @delo/plugin-onboarding/client/locales
 */

/** English dictionary. */
export const en = {
  'steps': 'Onboarding steps',
  'skip': 'Skip for now',
  'back': 'Back',
  'continue': 'Continue',
  'start': 'Start a chat',
  'count': 'Step {n} of {total}',
  'step.notice': 'Preview notice',
  'step.look': 'Language and look',
  'step.agents': 'Agents',
  'step.plugins': 'Recommended plugins',
  'step.reach': 'Reach',
  'step.start': 'Start',

  'look.lead': 'Choose your language and how Delo looks. You can change all of this later in Settings.',
  'look.language': 'Language',
  'look.studio': 'Studio look',
  'look.studio.lead': 'Delo\'s look is on now. The stock look is DeepSeek Harness as its developers ship it. Choosing it turns Delo\'s studio additions off, which removes this guide, and Settings → General turns them back on.',

  'saveFailed': 'Could not save this. Try again.',

  'agents.lead': 'Delo\'s agent can hand a task to another coding agent. Adding one only makes it available; nothing starts until you ask for it in a chat.',
  'agents.warning': 'Claude Code and Codex run as their own programs, with their own permissions, outside Delo\'s permission prompts. Delo cannot ask you before they act, so add one only if you trust it with your workspace.',
  'agents.claude.title': 'Claude Code',
  'agents.claude.description': 'Anthropic\'s coding agent. It needs its own sign-in.',
  'agents.codex.title': 'Codex',
  'agents.codex.description': 'OpenAI\'s coding agent. It needs its own sign-in.',
  'agents.later': 'You can add or remove them any time in Plugins.',

  'plugins.lead': 'Plugins add to the studio and to the agent. These are a good start, and none is added unless you choose it.',
  'plugins.later': 'Find many more in Plugins.',

  'bundle.checking': 'Checking…',
  'bundle.add': 'Add',
  'bundle.adding': 'Adding…',
  'bundle.added': 'Added',
  'bundle.restart': 'Added. Restart Delo to use it.',
  'bundle.unavailable': 'This installation does not offer it.',
  'bundle.failed': 'It could not be added here.',
  'bundle.open': 'Open Plugins',

  'reach.lead': 'Reach lets you open this studio from your phone or another computer. It is off until you turn it on.',
  'reach.where': 'You set it up at the computer that runs Delo, in a terminal, never from this window.',
  'reach.options': 'The options are Tailscale (private to your devices, or public), or a relay on your own domain. None of them uses Delo\'s servers.',
  'reach.skip': 'You can skip this: Delo works on this computer without it.',

  'start.lead': 'Delo opens a new chat in your default workspace.',
  'start.point': 'The chat shows a few starting prompts. Choosing one writes it into the message box; you read it, change it if you like, and send it yourself.',
  'start.later': 'Settings → About shows this guide again.',

  'starter.lead': 'Try one',
  'starter.dismiss': 'Hide the starting prompts',
  'starter.1.label': 'What can you do here?',
  'starter.1.prompt': 'What can you do in this workspace? Give me a few concrete examples.',
  'starter.2.label': 'Plan a small project',
  'starter.2.prompt': 'Help me plan a small project. Ask me what I want to build before you suggest anything.',
  'starter.3.label': 'Suggest a first task',
  'starter.3.prompt': 'Look at this workspace and suggest a good first task for us to do together.',

  'row.title': 'Onboarding',
  'row.description': 'Go through the first-run guide again. Your settings stay as they are.',
  'row.show': 'Show again',
} as const satisfies Record<string, string>

/** A key of the dictionary. */
export type OnboardingLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<OnboardingLocaleKey, string> = {
  'steps': '引导步骤',
  'skip': '暂时跳过',
  'back': '上一步',
  'continue': '继续',
  'start': '开始对话',
  'count': '第 {n} 步，共 {total} 步',
  'step.notice': '预览版说明',
  'step.look': '语言与外观',
  'step.agents': '智能体',
  'step.plugins': '推荐插件',
  'step.reach': '远程访问',
  'step.start': '开始',

  'look.lead': '选择语言和 Delo 的外观。这些之后都可以在设置中修改。',
  'look.language': '语言',
  'look.studio': '工作室外观',
  'look.studio.lead': '现在使用的是 Delo 的外观。原版外观是 DeepSeek Harness 开发者发布的样子。选择它会关闭 Delo 的工作室附加功能，本引导也会随之移除；在“设置 → 通用”中可以重新打开。',

  'saveFailed': '无法保存，请重试。',

  'agents.lead': 'Delo 的智能体可以把任务交给另一个编程智能体。添加只是让它可用；在你于对话中提出之前，不会启动任何东西。',
  'agents.warning': 'Claude Code 和 Codex 作为各自独立的程序运行，使用各自的权限，不受 Delo 权限提示的约束。它们行动之前 Delo 无法征求你的同意，所以只有信任它们访问你的工作区时才添加。',
  'agents.claude.title': 'Claude Code',
  'agents.claude.description': 'Anthropic 的编程智能体，需要单独登录。',
  'agents.codex.title': 'Codex',
  'agents.codex.description': 'OpenAI 的编程智能体，需要单独登录。',
  'agents.later': '随时可以在“插件”中添加或移除。',

  'plugins.lead': '插件为工作室和智能体增加功能。这些是不错的开始，只有你选择了才会添加。',
  'plugins.later': '在“插件”中可以找到更多。',

  'bundle.checking': '正在检查…',
  'bundle.add': '添加',
  'bundle.adding': '正在添加…',
  'bundle.added': '已添加',
  'bundle.restart': '已添加。重启 Delo 后可用。',
  'bundle.unavailable': '当前安装不提供它。',
  'bundle.failed': '无法在此添加。',
  'bundle.open': '打开插件',

  'reach.lead': '远程访问让你可以在手机或另一台电脑上打开这个工作室。在你打开之前，它是关闭的。',
  'reach.where': '它在运行 Delo 的那台电脑上通过终端设置，不能在这个窗口中设置。',
  'reach.options': '可选项有 Tailscale（仅你的设备可见，或公开）以及你自己域名上的中继。它们都不使用 Delo 的服务器。',
  'reach.skip': '可以跳过：没有它，Delo 在这台电脑上照常使用。',

  'start.lead': 'Delo 会在你的默认工作区中打开一个新对话。',
  'start.point': '对话中会显示几条起始提示。选择其中一条会把它写入消息框；你可以阅读、按需修改，并自己发送。',
  'start.later': '“设置 → 关于”中可以再次打开本引导。',

  'starter.lead': '试试看',
  'starter.dismiss': '隐藏起始提示',
  'starter.1.label': '你在这里能做什么？',
  'starter.1.prompt': '你在这个工作区里能做什么？请给我几个具体的例子。',
  'starter.2.label': '规划一个小项目',
  'starter.2.prompt': '帮我规划一个小项目。在提出任何建议之前，先问我想做什么。',
  'starter.3.label': '建议第一个任务',
  'starter.3.prompt': '看看这个工作区，建议我们一起做的第一个任务。',

  'row.title': '新手引导',
  'row.description': '再走一遍首次运行的引导。你的设置保持不变。',
  'row.show': '再次显示',
}
