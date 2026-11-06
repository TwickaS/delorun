/** The Main chat row's, its opening panel's and the first-message composer's copy. */

/** English dictionary. */
export const en = {
  'row': 'Main chat',
  'row.unread': 'New reports from your other chats',
  'open.failed': 'The main chat did not open.',
  'open.retry': 'Try again',
  'start.title': 'Main chat',
  'start.lead': 'One chat across all your workspaces: it reads your other chats and starts work in a workspace for you.',
  'start.input': 'Message to the main chat',
  'start.placeholder': 'Ask about your workspaces, or describe work to start in one',
  'start.send': 'Send message',
  'start.failed': 'The message was not sent. Try again.',
}

/** Chinese dictionary. */
export const zh: typeof en = {
  'row': '主对话',
  'row.unread': '其他对话有新的报告',
  'open.failed': '主对话未能打开。',
  'open.retry': '重试',
  'start.title': '主对话',
  'start.lead': '贯穿所有工作区的一个对话：它能读取你的其他对话，并替你在工作区中开始工作。',
  'start.input': '发给主对话的消息',
  'start.placeholder': '询问你的工作区，或描述要在某个工作区中开始的工作',
  'start.send': '发送消息',
  'start.failed': '消息未发送，请重试。',
}

/** A key of the dictionaries. */
export type MainChatLocaleKey = keyof typeof en
