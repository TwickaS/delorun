/**
 * The PIN step's copy, in English and Chinese, kept apart from the other steps' dictionaries and spread into them.
 * @module @delorun/plugin-onboarding/client/pin-locales
 */

/** English dictionary. */
export const pinEn = {
  'step.pin': 'PIN',
  'pin.lead': 'A paired phone asks for your PIN only before actions that need an unlock, such as adding plugins or allowing full access. It stays unlocked while you use it.',
  'pin.here': 'You set or change it here, at this computer. A phone never can.',
  'pin.reading': 'Checking PIN mode…',
  'pin.label': 'PIN or passcode',
  'pin.confirm': 'Type it again',
  'pin.help': 'A PIN is at least 6 digits and not a repeat or a run. A passcode is at least 10 characters.',
  'pin.retry': 'Try again',
  'pin.skipNote': 'Continue sets the PIN. Skip leaves PIN mode off; you can turn it on later in Settings.',
  'pin.on': 'PIN mode is on',
  'pin.on.pin': 'A paired phone unlocks with your PIN.',
  'pin.on.passcode': 'A paired phone unlocks with your passcode.',
  'pin.changeInSettings': 'Change it in Settings',
  'pin.unavailable': 'PIN mode is not available in this profile. You can continue.',
  'pin.problem.mismatch': 'The two entries do not match. Type the same PIN twice.',
  'pin.problem.tooLong': 'That is longer than 128 characters. Choose a shorter one.',
  'pin.problem.pinShort': 'A PIN has at least 6 digits. Add more digits or use a passcode.',
  'pin.problem.pinWeak': 'That PIN is a repeat, a run or a common PIN. Choose another.',
  'pin.problem.passcodeShort': 'A passcode has at least 10 characters. Digits only make a PIN, which needs 6.',
  'pin.problem.passcodeRepeat': 'A passcode is not one character repeated. Choose another.',
  'pin.loopback': 'PIN mode can be set only in the studio on this computer. Open Delorun there to set it.',
  'pin.unreachable': 'The home did not answer. Check that Delorun is still running, then try again.',
  'pin.unreadable': 'The home\'s answer could not be read. Try again.',
} as const satisfies Record<string, string>

/** A key of the PIN step's dictionary. */
export type PinLocaleKey = keyof typeof pinEn

/** Chinese dictionary. */
export const pinZh: Record<PinLocaleKey, string> = {
  'step.pin': 'PIN',
  'pin.lead': '已配对的手机只会在需要解锁的操作之前（例如添加插件或允许完全访问）询问你的 PIN。你在使用期间，它会保持解锁。',
  'pin.here': '只能在这台电脑上设置或更改，手机不能。',
  'pin.reading': '正在检查 PIN 模式…',
  'pin.label': 'PIN 或口令',
  'pin.confirm': '再输入一次',
  'pin.help': 'PIN 至少 6 位数字，且不能是重复或连续数字。口令至少 10 个字符。',
  'pin.retry': '重试',
  'pin.skipNote': '继续会设置 PIN。跳过则保持 PIN 模式关闭，之后可在设置中开启。',
  'pin.on': 'PIN 模式已开启',
  'pin.on.pin': '已配对的手机用你的 PIN 解锁。',
  'pin.on.passcode': '已配对的手机用你的口令解锁。',
  'pin.changeInSettings': '在设置中更改',
  'pin.unavailable': '当前 profile 不提供 PIN 模式。可以继续。',
  'pin.problem.mismatch': '两次输入不一致，请输入相同的 PIN。',
  'pin.problem.tooLong': '超过 128 个字符，请换一个短一些的。',
  'pin.problem.pinShort': 'PIN 至少 6 位数字。请多输入几位，或改用口令。',
  'pin.problem.pinWeak': '这个 PIN 是重复、连续或常见的 PIN，请换一个。',
  'pin.problem.passcodeShort': '口令至少 10 个字符。只含数字的是 PIN，需要 6 位。',
  'pin.problem.passcodeRepeat': '口令不能由同一个字符重复组成，请换一个。',
  'pin.loopback': '只能在这台电脑上的 studio 中设置 PIN 模式。请在那里打开 Delorun 来设置。',
  'pin.unreachable': '主机没有响应。请确认 Delorun 仍在运行，然后重试。',
  'pin.unreadable': '无法读取主机的回应，请重试。',
}
