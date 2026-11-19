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
  'pairStepExtension': 'Add the browse extension to Chrome.',
  'pairOpenStore': 'Open the Chrome Web Store',
  'pairStart': 'Get a pairing code',
  'pairAgain': 'Get a new code',
  'pairStepCode': 'In Chrome, open Extensions → browse → Options, choose Pair with a code, enter this code and click Connect:',
  'pairCodeLabel': 'Pairing code',
  'pairWaiting': 'Waiting for Chrome…',
  'pairDone': 'Connected: {name}',
  'pairDoneUnnamed': 'Chrome is connected.',
  'pairExpired': 'The code ran out before Chrome used it.',
  'pairFailed': 'Pairing did not work: {message}',
  'pairComputerOnly': 'Pair from the studio on your computer.',
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
  'pairStepExtension': '在 Chrome 中添加 browse 扩展。',
  'pairOpenStore': '打开 Chrome 应用店',
  'pairStart': '获取配对码',
  'pairAgain': '获取新配对码',
  'pairStepCode': '在 Chrome 中打开“扩展程序 → browse → 选项”，选择“用配对码配对”，输入此配对码并点击“连接”：',
  'pairCodeLabel': '配对码',
  'pairWaiting': '正在等待 Chrome…',
  'pairDone': '已连接：{name}',
  'pairDoneUnnamed': 'Chrome 已连接。',
  'pairExpired': '配对码在 Chrome 使用前已过期。',
  'pairFailed': '配对未成功：{message}',
  'pairComputerOnly': '请在电脑上的工作室中配对。',
} as const satisfies Record<RequirementsLocaleKey, string>
