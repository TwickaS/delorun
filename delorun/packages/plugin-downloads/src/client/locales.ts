/** The downloads panel's copy. */

/** The dictionary namespace this plugin owns. */
export const NS = 'delorunDownloads'

/** English dictionary. Plural pairs are chosen by count: `.one` for 1, `.other` otherwise. */
export const en = {
  'title': 'Downloads',
  'header': '{left} left to install',
  'header.waitingUnlock': 'Not confirmed',
  'header.attention.one': '{n} plugin could not be installed',
  'header.attention.other': '{n} plugins could not be installed',
  'summary.one': '{n} plugin added',
  'summary.other': '{n} plugins added',
  'announce.failed': '{name} could not be installed',
  'collapse': 'Collapse the downloads',
  'expand': 'Show the downloads',
  'dismiss': 'Dismiss',
  'list': 'Plugins being installed',
  'state.downloading': 'Downloading',
  'state.downloadingRate': '{percent}% · {rate}',
  'state.receivedRate': '{size} · {rate}',
  'rate.speedLeft': '{speed} · ~{time} left',
  'state.queued': 'Waiting · {ahead} ahead',
  'state.queuedNext': 'Waiting · next',
  'state.queuedNoPosition': 'Waiting',
  'state.waitingForUnlock': 'Not confirmed. Try again to confirm with Face ID or your PIN',
  'state.verifying': 'Checking',
  'state.installing': 'Installing',
  'state.ready': 'Added',
  'state.needsReload': 'Added, reload to use it',
  'state.failed': 'Not installed',
  'notLoading': 'Installed, but not loading: {reason}',
  'uninstallItem': 'Remove {name}',
  'notRemoved': 'It could not be removed.',
  'progress': '{name}: {percent}%',
  'cancel': 'Cancel',
  'cancelItem': 'Cancel {name}',
  'retry': 'Try again',
  'add': 'Add',
  'addItem': 'Add {name}',
  'added': 'Added',
  'retryItem': 'Try {name} again',
  'remove': 'Remove',
  'removeItem': 'Remove {name} from the list',
  'sheet.open': 'Downloads, {n} in progress',
  'sheet.close': 'Close',
  'row.failed': 'Something could not be installed',
  'pack.browser': 'Browser',
  'pack.realBrowser': 'Your own browser',
  'pack.codeIntelligence': 'Code intelligence',
  'pack.agentHooks': 'Claude Code and Codex hooks',
  'pack.webhooks': 'Webhooks',
  'pack.externalAgents': 'External agents',
  'pack.computerUseDriver': 'Computer use (Cua Driver)',
  'pack.claudeCode': 'Claude Code',
  'pack.codex': 'Codex',
  'pack.chromium': 'Chromium for Browser',
}

/** A key of the dictionary. */
export type DownloadsLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: typeof en = {
  'title': '下载',
  'header': '还剩 {left} 个待安装',
  'header.waitingUnlock': '未确认',
  'header.attention.one': '{n} 个插件未能安装',
  'header.attention.other': '{n} 个插件未能安装',
  'summary.one': '已添加 {n} 个插件',
  'summary.other': '已添加 {n} 个插件',
  'announce.failed': '{name} 未能安装',
  'collapse': '收起下载',
  'expand': '显示下载',
  'dismiss': '关闭',
  'list': '正在安装的插件',
  'state.downloading': '正在下载',
  'state.downloadingRate': '{percent}% · {rate}',
  'state.receivedRate': '{size} · {rate}',
  'rate.speedLeft': '{speed} · 约剩 {time}',
  'state.queued': '排队中 · 前面还有 {ahead} 个',
  'state.queuedNext': '排队中 · 下一个',
  'state.queuedNoPosition': '等待中',
  'state.waitingForUnlock': '未确认。请重试，并用 Face ID 或你的 PIN 确认',
  'state.verifying': '正在检查',
  'state.installing': '正在安装',
  'state.ready': '已添加',
  'state.needsReload': '已添加，重新加载后可用',
  'state.failed': '未安装',
  'notLoading': '已安装，但未能加载：{reason}',
  'uninstallItem': '移除 {name}',
  'notRemoved': '无法移除。',
  'progress': '{name}：{percent}%',
  'cancel': '取消',
  'cancelItem': '取消 {name}',
  'retry': '重试',
  'add': '添加',
  'addItem': '添加 {name}',
  'added': '已添加',
  'retryItem': '重试 {name}',
  'remove': '移除',
  'removeItem': '从列表中移除 {name}',
  'sheet.open': '下载，{n} 个进行中',
  'sheet.close': '关闭',
  'row.failed': '有插件未能安装',
  'pack.browser': '浏览器',
  'pack.realBrowser': '你自己的浏览器',
  'pack.codeIntelligence': '代码智能',
  'pack.agentHooks': 'Claude Code 与 Codex 钩子',
  'pack.webhooks': 'Webhook',
  'pack.externalAgents': '外部智能体',
  'pack.computerUseDriver': '计算机使用（Cua Driver）',
  'pack.claudeCode': 'Claude Code',
  'pack.codex': 'Codex',
  'pack.chromium': '浏览器使用的 Chromium',
}

/** The translate function the components take: the slot machinery's, or a stand-in. */
export type Translate = (key: DownloadsLocaleKey, params?: Record<string, string | number>) => string

/**
 * Choose a plural entry by count.
 * @param base - the entry without its suffix.
 * @param count - the number.
 * @returns the `.one` key for 1, otherwise the `.other` key.
 */
export function pluralKey<B extends 'header.attention' | 'summary'>(base: B, count: number): `${B}.one` | `${B}.other` {
  return count === 1 ? `${base}.one` : `${base}.other`
}

/**
 * An English translate with {name} substitution, for the surfaces that render before the plugin binds its own.
 * @param key - the entry.
 * @param params - the placeholders.
 * @returns the text.
 */
export const fallbackTranslate: Translate = (key, params = {}) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
