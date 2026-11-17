/** The stop notice's copy. */

/** The dictionary namespace this plugin owns. */
export const NS = 'delorunToolFailureGuard'

/** English dictionary. */
export const en = {
  'stop.title': 'Stopped',
  'stop.message': 'Tool calls kept failing, so the turn stopped instead of using more tokens. Check the errors above, then send a message to carry on.',
}

/** A key of the dictionary. */
export type ToolFailureGuardLocaleKey = keyof typeof en

/** Simplified Chinese dictionary, checked against the English keys. */
export const zh = {
  'stop.title': '已停止',
  'stop.message': '工具调用接连失败，本轮已停止，以免继续消耗 token。请查看上方的错误，然后发送消息继续。',
} satisfies Record<ToolFailureGuardLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The tool-failure guard's stop notice. */
    delorunToolFailureGuard: ToolFailureGuardLocaleKey
  }
}
