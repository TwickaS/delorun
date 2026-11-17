/** The copy of the PIN lock screen that a device shows when an action needs an unlock. */

/** English dictionary. */
export const en = {
  'title': 'Unlock sensitive actions',
  'lead.pin': 'This needs your PIN. Enter it to go on; the studio stays open without it.',
  'lead.passcode': 'This needs your passcode. Enter it to go on; the studio stays open without it.',
  'notNow': 'Not now',
  'close': 'Close',
  'label.pin': 'PIN',
  'label.passcode': 'Passcode',
  'unlock': 'Unlock',
  'unlocking': 'Unlocking…',
  'key.delete': 'Delete the last digit',
  'wrong.one': 'That is not right. 1 try left before this device is signed out.',
  'wrong.other': 'That is not right. {count} tries left before this device is signed out.',
  'wrong.unknown': 'That is not right. Try again.',
  'removed.title': 'This device is signed out',
  'removed.body': 'That was the last wrong try. Approve this device again at your computer, then open the studio here.',
  'paused': 'Unlocks are paused after too many wrong tries across your devices. They resume when you resume them at your computer.',
  'unreachable': 'Your computer can\'t be reached right now. Check that Delorun is running there, then try again.',
  'address': 'A PIN unlocks only on your computer\'s private Tailscale address. Open the studio from that address.',
  'failed': 'The unlock did not work. Try again.',
  'paused.title': 'Unlocks are paused',
  'unreachable.title': 'Your computer is out of reach',
  'address.title': 'Use the private address',
  'failed.title': 'That did not work',
}

/** A key of the lock screen's dictionary. */
export type PinLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: typeof en = {
  'title': '解锁敏感操作',
  'lead.pin': '这需要你的 PIN。输入后即可继续；不输入也可以继续使用 studio。',
  'lead.passcode': '这需要你的密码短语。输入后即可继续；不输入也可以继续使用 studio。',
  'notNow': '暂不',
  'close': '关闭',
  'label.pin': 'PIN',
  'label.passcode': '密码短语',
  'unlock': '解锁',
  'unlocking': '正在解锁…',
  'key.delete': '删除最后一位数字',
  'wrong.one': '不正确。这台设备退出登录前还剩 1 次机会',
  'wrong.other': '不正确。这台设备退出登录前还剩 {count} 次机会',
  'wrong.unknown': '不正确，请重试',
  'removed.title': '这台设备已退出登录',
  'removed.body': '这是最后一次错误尝试。请先在你的电脑上重新批准这台设备，再在这里打开 studio。',
  'paused': '多台设备累计输错次数过多，解锁已暂停。在你的电脑上恢复后即可继续解锁。',
  'unreachable': '暂时无法连接你的电脑。请确认 Delorun 正在那里运行，然后重试',
  'address': 'PIN 只能在你电脑的 Tailscale 私有地址上解锁。请从该地址打开 studio。',
  'failed': '解锁未成功，请重试',
  'paused.title': '解锁已暂停',
  'unreachable.title': '连接不到你的电脑',
  'address.title': '请使用私有地址',
  'failed.title': '未成功',
}
