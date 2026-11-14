/** The Thinking tab's copy. */

/** The namespace the tab's dictionaries register under. */
export const NS = 'thinking-rsvp'

/** English copy, the key set every other dictionary matches. */
export const en = {
  'tab.title': 'Thinking',
  'tab.description': 'Read the model’s reasoning and reply word by word as it writes them.',
  'part.reasoning': 'Reasoning',
  'part.reply': 'Reply',
  'page.read': 'Read so far',
  'page.ahead': 'Still to read',
  'band.aria': 'Current word',
  'state.empty': 'Nothing to read yet. The model’s reasoning and reply appear here as it writes them.',
  'state.paused': 'Paused',
  'state.waiting': 'Waiting for the model',
  'state.finished': 'End of this turn',
  'control.play': 'Play',
  'control.pause': 'Pause',
  'control.restart': 'Start again',
  'control.stepBack': 'Previous word',
  'control.stepForward': 'Next word',
  'control.skipToLive': 'Skip to live',
  'control.source': 'Read',
  'control.source.reasoning': 'Reasoning',
  'control.source.reply': 'Reply',
  'control.source.both': 'Both',
  'control.pace': 'Pace',
  'control.pace.live': 'Live',
  'control.pace.rate': 'Set rate',
  'control.pace.model': 'Model’s rate',
  'control.wpm': '{wpm} words a minute',
  'control.slower': 'Slower',
  'control.faster': 'Faster',
  'control.delay': 'Delay',
  'control.delayValue': '{seconds} s behind',
  'control.delayNone': 'No delay',
  'control.lessDelay': 'Less delay',
  'control.moreDelay': 'More delay',
} as const

/** The tab's dictionary keys. */
export type ThinkingRsvpKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Thinking tab's copy. */
    'thinking-rsvp': ThinkingRsvpKey
  }
}

/** Chinese copy. */
export const zh: Record<ThinkingRsvpKey, string> = {
  'tab.title': '思考',
  'tab.description': '在模型书写时逐词阅读它的推理与回复。',
  'part.reasoning': '推理',
  'part.reply': '回复',
  'page.read': '已读',
  'page.ahead': '待读',
  'band.aria': '当前词',
  'state.empty': '暂无可读内容。模型书写推理与回复时会显示在这里。',
  'state.paused': '已暂停',
  'state.waiting': '等待模型',
  'state.finished': '本轮结束',
  'control.play': '播放',
  'control.pause': '暂停',
  'control.restart': '从头开始',
  'control.stepBack': '上一个词',
  'control.stepForward': '下一个词',
  'control.skipToLive': '跳到最新',
  'control.source': '阅读',
  'control.source.reasoning': '推理',
  'control.source.reply': '回复',
  'control.source.both': '两者',
  'control.pace': '节奏',
  'control.pace.live': '实时',
  'control.pace.rate': '设定速度',
  'control.pace.model': '模型速度',
  'control.wpm': '每分钟 {wpm} 词',
  'control.slower': '更慢',
  'control.faster': '更快',
  'control.delay': '延迟',
  'control.delayValue': '落后 {seconds} 秒',
  'control.delayNone': '无延迟',
  'control.lessDelay': '减少延迟',
  'control.moreDelay': '增加延迟',
}
