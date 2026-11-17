/** The copy of the "Needs setup" state in Plugins. The reasons are the bundles' own, in their locale files. */

/** English dictionary. */
export const en = {
  'state': 'Needs setup · {reason}',
  'copy': 'Copy',
  'copied': 'Copied',
  'copyLabel': 'Copy the command: {command}',
  'commandLabel': 'Command',
  'openSettings': 'Open settings',
  'openDocs': 'Read how',
  'problem': 'Could not read what {name} needs: {message}',
  'checkFailed': 'Could not check what this plugin needs.',
} as const

/** The dictionary's keys. */
export type RequirementsLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh = {
  'state': '需要设置 · {reason}',
  'copy': '复制',
  'copied': '已复制',
  'copyLabel': '复制命令：{command}',
  'commandLabel': '命令',
  'openSettings': '打开设置',
  'openDocs': '查看方法',
  'problem': '无法读取 {name} 的需求：{message}',
  'checkFailed': '无法检查此插件的需求。',
} as const satisfies Record<RequirementsLocaleKey, string>
