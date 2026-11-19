/** Copy of the agents list, the hand-off line and the team view. */

/** The dictionary namespace of the lists. */
export const NS = 'delorunAgentSeatLists'

/** English dictionary. */
export const en = {
  'row.outside.aria': '{agent}, runs outside Delorun',
  'row.working': 'Working',
  'row.starting': 'Starting',
  'row.idle': 'Waiting for your message',
  'row.waiting': 'Waiting for you',
  'row.limit': 'Limit reached · resets {time}',
  'row.limitNoTime': 'Limit reached',
  'row.notSignedIn': 'Not signed in',
  'row.modelNeeded': 'Needs a model',
  'row.ended': 'Left the chat',
  'row.answer': 'Answer',
  'row.answer.aria': 'Answer {label}, {agent}',
  'ring.aria': '{agent} 5-hour limit {percent}% used',
  'ring.reached.aria': '{agent} has reached its 5-hour limit',
  'ring.text': '{percent}%',
  'trigger.outside': '{count} outside',
  'handoff.line': 'Handed to {agent} · {task}',
  'handoff.lineNoTask': 'Handed to {agent}',
  'handoff.running': 'Working · {time}',
  'handoff.finished': 'Finished in {time}',
  'handoff.failed': 'Stopped · {time}',
  'handoff.open': 'Open',
  'handoff.open.aria': 'Open {task}, {agent}',
  'handoff.fullAccess': 'Started without asking · Full access',
  'handoff.answer.title': 'Answer from {agent}',
  'handoff.answer.open': 'Open its chat',
}

/** Chinese dictionary. */
export const zh: Record<ListsKey, string> = {
  'row.outside.aria': '{agent}，在 Delorun 之外运行',
  'row.working': '工作中',
  'row.starting': '正在启动',
  'row.idle': '等待你的消息',
  'row.waiting': '等你回答',
  'row.limit': '已达上限 · {time} 重置',
  'row.limitNoTime': '已达上限',
  'row.notSignedIn': '未登录',
  'row.modelNeeded': '需要选择模型',
  'row.ended': '已离开聊天',
  'row.answer': '回答',
  'row.answer.aria': '回答 {label}（{agent}）',
  'ring.aria': '{agent} 的 5 小时额度已用 {percent}%',
  'ring.reached.aria': '{agent} 已达到 5 小时额度上限',
  'ring.text': '{percent}%',
  'trigger.outside': '{count} 个在外部',
  'handoff.line': '已交给 {agent} · {task}',
  'handoff.lineNoTask': '已交给 {agent}',
  'handoff.running': '工作中 · {time}',
  'handoff.finished': '用时 {time} 完成',
  'handoff.failed': '已停止 · {time}',
  'handoff.open': '打开',
  'handoff.open.aria': '打开 {task}（{agent}）',
  'handoff.fullAccess': '未经询问直接启动 · 完全访问',
  'handoff.answer.title': '{agent} 的回答',
  'handoff.answer.open': '打开它的聊天',
}

/** A dictionary key of the lists. */
export type ListsKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The agents list, hand-off line and team view copy of the live agents. */
    'delorunAgentSeatLists': ListsKey
  }
}
