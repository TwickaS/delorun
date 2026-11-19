/** The Go back panel's words, spread into the update screens' dictionaries by `locales.ts`. */

/** English words of the Go back panel. */
export const rollbackEn = {
  'rollback.title': 'Go back to Delorun {version}',
  'rollback.body': 'Delorun {running} started after an update. Going back returns to {version}. Chats made since the update are set aside, not deleted, and you can remove them later in Settings → Trash.',
  'rollback.noCopy': 'No copy of your chats was taken before the update, so only your settings can go back. Your chats stay as they are.',
  'rollback.button': 'Go back…',
  'rollback.buttonSettings': 'Go back, settings only…',
  'rollback.dialog.title': 'Go back to Delorun {version}?',
  'rollback.dialog.body': 'Delorun restarts on {version} with your settings from before the update.',
  'rollback.dialog.bodySettings': 'Delorun restarts on {version} with your settings from before the update. Your chats stay as they are.',
  'rollback.chats.stop': 'Stop running chats now',
  'rollback.confirm': 'Go back',
  'rollback.confirmSettings': 'Go back, settings only',
}

/** Chinese words of the Go back panel. */
export const rollbackZh: typeof rollbackEn = {
  'rollback.title': '退回到 Delorun {version}',
  'rollback.body': 'Delorun {running} 是在一次更新后启动的。退回会回到 {version}。更新后创建的聊天会被搁置，不会被删除，你之后可以在“设置 → 废纸篓”中移除。',
  'rollback.noCopy': '更新前没有备份你的聊天，因此只能退回设置。你的聊天保持原样。',
  'rollback.button': '退回…',
  'rollback.buttonSettings': '仅退回设置…',
  'rollback.dialog.title': '退回到 Delorun {version}？',
  'rollback.dialog.body': 'Delorun 会重新启动为 {version}，并使用更新前的设置。',
  'rollback.dialog.bodySettings': 'Delorun 会重新启动为 {version}，并使用更新前的设置。你的聊天保持原样。',
  'rollback.chats.stop': '立即停止正在运行的聊天',
  'rollback.confirm': '退回',
  'rollback.confirmSettings': '仅退回设置',
}
