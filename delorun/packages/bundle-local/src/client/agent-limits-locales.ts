/**
 * The copy of the sign-in line, the limit bars and "Check now", shared by every surface that shows them. Each surface
 * spreads these into its own dictionary, so they sit beside its other keys.
 * @module @delorun/bundle-local/client/agent-limits-locales
 */

/** English dictionary. */
export const limitsEn = {
  'limits.time.locale': 'en',
  'limits.signedIn': 'Signed in',
  'limits.signedInPlan': 'Signed in · {plan} plan',
  'limits.signedOut': 'Not signed in',
  'limits.signInUnknown': 'Sign-in not checked yet',
  'limits.percent': '{percent}% used',
  'limits.noFigure': 'No figure',
  'limits.status.near': 'Near the limit',
  'limits.status.reached': 'Limit reached',
  'limits.resets': 'Resets {time}',
  'limits.resetPassed': 'Reset at {time}, not checked since',
  'limits.asOf': 'As of {time}',
  'limits.lastSeen': 'Last seen {time}',
  'limits.none': 'No limit figures yet.',
  'limits.window.five_hour': '5-hour limit',
  'limits.window.seven_day': 'Weekly limit',
  'limits.window.hours': '{count}-hour limit',
  'limits.window.days': '{count}-day limit',
  'limits.check': 'Check now',
  'limits.checking': 'Checking…',
  'limits.unlockToCheck': 'Unlock to check',
  'limits.unlockNeeded': 'Unlock this device to check. Checks start the agent\'s program on your computer.',
  'limits.checked': 'Checked.',
  'limits.throttled': 'Checked a moment ago. The next check can run from {time}.',
  'limits.failed': 'The check did not answer: {problem}',
  'limits.refused': 'The check did not start: {problem}',
  'limits.notAdded': 'Add this agent first, then check.',
  'limits.turnedOff': 'This profile does not check plan limits.',
  'limits.unreachable': 'Delorun could not be reached.',
  'limits.unreadable': 'Delorun answered something this page cannot read.',
  'limits.unavailable': 'Plan limits are not available here.',
  'limits.computerOnly': 'Open this on the computer that runs Delorun to see plan limits.',
  'limits.group': 'Plan limits of {agent}',
  'limits.bar': '{title}: {value}',
} satisfies Record<string, string>

/** The keys of {@link limitsEn}. */
export type LimitsKey = keyof typeof limitsEn

/** Chinese dictionary. */
export const limitsZh: Readonly<Record<LimitsKey, string>> = {
  'limits.time.locale': 'zh-CN',
  'limits.signedIn': '已登录',
  'limits.signedInPlan': '已登录 · {plan} 套餐',
  'limits.signedOut': '未登录',
  'limits.signInUnknown': '尚未检查登录状态',
  'limits.percent': '已用 {percent}%',
  'limits.noFigure': '暂无数据',
  'limits.status.near': '接近上限',
  'limits.status.reached': '已达上限',
  'limits.resets': '{time} 重置',
  'limits.resetPassed': '{time} 已重置，此后未再检查',
  'limits.asOf': '截至 {time}',
  'limits.lastSeen': '上次看到：{time}',
  'limits.none': '暂无额度数据。',
  'limits.window.five_hour': '5 小时额度',
  'limits.window.seven_day': '每周额度',
  'limits.window.hours': '{count} 小时额度',
  'limits.window.days': '{count} 天额度',
  'limits.check': '立即检查',
  'limits.checking': '正在检查…',
  'limits.unlockToCheck': '解锁后检查',
  'limits.unlockNeeded': '请先解锁此设备再检查。检查会在你的电脑上启动该智能体的程序。',
  'limits.checked': '已检查。',
  'limits.throttled': '刚刚检查过。下次检查最早在 {time}。',
  'limits.failed': '检查未得到回应：{problem}',
  'limits.refused': '检查未能启动：{problem}',
  'limits.notAdded': '请先添加此智能体，再检查。',
  'limits.turnedOff': '此配置不检查套餐额度。',
  'limits.unreachable': '无法连接到 Delorun。',
  'limits.unreadable': 'Delorun 返回了此页面无法读取的内容。',
  'limits.unavailable': '此处无法查看套餐额度。',
  'limits.computerOnly': '请在运行 Delorun 的电脑上打开此页面以查看套餐额度。',
  'limits.group': '{agent} 的套餐额度',
  'limits.bar': '{title}：{value}',
}
