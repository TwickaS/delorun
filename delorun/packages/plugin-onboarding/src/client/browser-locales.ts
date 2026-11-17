/**
 * The Browser step's copy, in English and Chinese, kept apart from the other steps' dictionaries and spread into them,
 * with the words of the shared Browser choice and its preview chip from `@delorun/browser-setup`.
 * @module @delorun/plugin-onboarding/client/browser-locales
 */
import { en as choiceEn, zh as choiceZh } from '@delorun/browser-setup/locales'

/** English dictionary. */
export const browserEn = {
  ...choiceEn,
  'step.browser': 'Browser',
  'browser.lead': 'Browser lets the agent open web pages, click and read them in a browser on this computer. Choosing the isolated browser adds the Browser plugin.',
  'browser.added': 'Browser was added. Delorun checks whether it is ready once it has loaded.',
  'browser.turnOff.restart': 'Browser turns off the next time Delorun starts.',
  'browser.turnOff.failed': 'Delorun could not turn Browser off. Turn it off in Plugins.',
  'browser.expect': 'What to expect',
  'browser.expect.asks.title': 'It asks once',
  'browser.expect.asks.text': 'The first chat that uses Browser asks you to allow its browser tool, playwright-mcp. Allow it once and Delorun does not ask again.',
  'browser.expect.own.title': 'Its own browser',
  'browser.expect.own.text': 'Browser runs apart from the browser you use, so it starts without your sign-ins.',
  'browser.expect.off.title': 'Off unless you choose it',
  'browser.expect.off.text': 'No chat opens a browser while No browser is chosen. You can change this later in Plugins.',
} as const satisfies Record<string, string>

/** Chinese dictionary. */
export const browserZh: Record<keyof typeof browserEn, string> = {
  ...choiceZh,
  'step.browser': '浏览器',
  'browser.lead': '“浏览器”让智能体在这台电脑的浏览器中打开网页、点击并阅读。选择独立浏览器会添加“浏览器”插件。',
  'browser.added': '“浏览器”已添加。加载完成后，Delorun 会检查它是否已就绪。',
  'browser.turnOff.restart': '“浏览器”将在 Delorun 下次启动时关闭。',
  'browser.turnOff.failed': 'Delorun 无法关闭“浏览器”。请在“插件”中关闭它。',
  'browser.expect': '会发生什么',
  'browser.expect.asks.title': '只询问一次',
  'browser.expect.asks.text': '第一个使用“浏览器”的对话会请你允许它的浏览器工具 playwright-mcp。允许一次后，Delorun 不会再询问。',
  'browser.expect.own.title': '独立的浏览器',
  'browser.expect.own.text': '“浏览器”与你平时使用的浏览器分开运行，因此启动时不带你的登录状态。',
  'browser.expect.off.title': '不选择就保持关闭',
  'browser.expect.off.text': '选择“不使用浏览器”时，任何对话都不会打开浏览器。你可以稍后在“插件”中更改。',
}
