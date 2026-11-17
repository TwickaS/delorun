/**
 * The Browser choice's copy, in English and Chinese, with the preview chip's own words. A plugin spreads it into its
 * own dictionaries and passes its bound translate function to `BrowserChoices`, so the words have one source.
 * @module @delorun/browser-setup/locales
 */
import { en as chipEn, zh as chipZh } from '@delorun/preview-flags/locales'

/** English dictionary. */
export const en = {
  ...chipEn,
  'browser.which': 'Can agents use a web browser?',
  'browser.choice.isolated.title': 'Isolated browser',
  'browser.choice.isolated.text': 'Agents open pages in a separate browser that starts without your sign-ins.',
  'browser.choice.none.title': 'No browser',
  'browser.choice.none.text': 'Agents cannot open web pages in a browser.',
  'browser.choice.mine.title': 'Use my browser',
  'browser.choice.mine.text': 'Your Chrome with your sign-ins, approved per chat.',
  'browser.choice.mine.preview': 'Planned and not built yet, so it cannot be chosen.',
  'browser.checking': 'Checking whether Browser is ready…',
  'browser.ready': 'Browser is ready to use.',
  'browser.needsSetup': 'Needs setup · {reason}',
  'browser.fix.command': 'Run this in a terminal on this computer. This checks again when you come back.',
  'browser.fix.settings': 'Open Settings',
  'browser.fix.docs': 'See how to install it',
  'browser.problem': 'Delorun could not read what Browser needs: {message}',
  'browser.unread': 'Delorun could not check whether Browser is ready.',
  'browser.retry': 'Try again',
  'browser.copy': 'Copy',
  'browser.copy.named': 'Copy {command}',
  'browser.copy.done': 'Copied',
  'browser.copy.failed': 'Could not copy. Select the command and copy it yourself.',
} as const satisfies Record<string, string>

/** Key union derived from the English dictionary. */
export type BrowserSetupLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<BrowserSetupLocaleKey, string> = {
  ...chipZh,
  'browser.which': '智能体可以使用网页浏览器吗？',
  'browser.choice.isolated.title': '独立浏览器',
  'browser.choice.isolated.text': '智能体在一个独立的浏览器中打开页面，它启动时不带你的登录状态。',
  'browser.choice.none.title': '不使用浏览器',
  'browser.choice.none.text': '智能体不能在浏览器中打开网页。',
  'browser.choice.mine.title': '使用我的浏览器',
  'browser.choice.mine.text': '带有你登录状态的 Chrome，每个对话单独批准。',
  'browser.choice.mine.preview': '已计划但尚未实现，因此无法选择。',
  'browser.checking': '正在检查“浏览器”是否已就绪…',
  'browser.ready': '“浏览器”已可以使用。',
  'browser.needsSetup': '需要设置 · {reason}',
  'browser.fix.command': '请在这台电脑的终端中运行此命令。你回到这里时会再次检查。',
  'browser.fix.settings': '打开设置',
  'browser.fix.docs': '查看如何安装',
  'browser.problem': 'Delorun 无法读取“浏览器”所需的条件：{message}',
  'browser.unread': 'Delorun 无法检查“浏览器”是否已就绪。',
  'browser.retry': '重试',
  'browser.copy': '复制',
  'browser.copy.named': '复制 {command}',
  'browser.copy.done': '已复制',
  'browser.copy.failed': '无法复制。请选中命令后自行复制。',
}
