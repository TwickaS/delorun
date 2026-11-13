/** The cost meter's copy: the pill, the breakdown dialog and its notes. */

/** The dictionary namespace this plugin owns. */
export const NS = 'deloCostMeter'

/** English dictionary. */
export const en = {
  'pill.label': 'Estimated chat cost {cost}',
  'pill.labelWithAgents': 'Estimated chat cost {cost}, {total} including agents',
  'pill.withAgents': '{total} with agents',
  'dialog.title': 'Chat cost',
  'dialog.titleWithAgents': 'Chat and agents cost',
  'column.name': 'Name',
  'column.requests': 'Requests',
  'column.tokens': 'Tokens',
  'column.cost': 'Cost',
  'group.thisChat': 'This chat',
  'group.agent': 'Agent {id}',
  'bucket.input': 'Input',
  'bucket.cacheWrite': 'Cache write',
  'bucket.cacheRead': 'Cache read',
  'bucket.output': 'Output',
  'row.label': '{name}: {requests} requests, {tokens} tokens, {cost}',
  'bucket.label': '{name}: {tokens} tokens',
  'cost.none': 'No price',
  'tokens.thousand': '{value}K',
  'tokens.million': '{value}M',
  'note.unpriced': '{count} requests have no price. Add their models to the cost meter\'s prices on the Plugins page in the sidebar.',
  'note.unpriced.one': '1 request has no price. Add its model to the cost meter\'s prices on the Plugins page in the sidebar.',
  'note.loading': 'The cost of {count} agents is not available yet.',
  'note.loading.one': 'The cost of 1 agent is not available yet.',
  'note.external': '{count} external agents run outside this studio and are not counted.',
  'note.external.one': '1 external agent runs outside this studio and is not counted.',
  'note.estimate': 'Estimated from list prices. Your provider\'s invoice is authoritative.',
}

/** A key of the dictionary. */
export type CostMeterLocaleKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The cost meter's copy. */
    'deloCostMeter': CostMeterLocaleKey
  }
}

/** Chinese dictionary. */
export const zh: Record<CostMeterLocaleKey, string> = {
  'pill.label': '估算对话费用 {cost}',
  'pill.labelWithAgents': '估算对话费用 {cost}，含智能体共 {total}',
  'pill.withAgents': '含智能体 {total}',
  'dialog.title': '对话费用',
  'dialog.titleWithAgents': '对话与智能体费用',
  'column.name': '名称',
  'column.requests': '请求',
  'column.tokens': 'Token',
  'column.cost': '费用',
  'group.thisChat': '本对话',
  'group.agent': '智能体 {id}',
  'bucket.input': '输入',
  'bucket.cacheWrite': '缓存写入',
  'bucket.cacheRead': '缓存读取',
  'bucket.output': '输出',
  'row.label': '{name}：{requests} 个请求，{tokens} Token，{cost}',
  'bucket.label': '{name}：{tokens} Token',
  'cost.none': '无价格',
  'tokens.thousand': '{value}K',
  'tokens.million': '{value}M',
  'note.unpriced': '{count} 个请求没有价格，请在侧边栏的“插件”页面中为其模型添加价格',
  'note.unpriced.one': '1 个请求没有价格，请在侧边栏的“插件”页面中为其模型添加价格',
  'note.loading': '{count} 个智能体的费用尚未加载',
  'note.loading.one': '1 个智能体的费用尚未加载',
  'note.external': '{count} 个外部智能体在本工作室之外运行，未计入',
  'note.external.one': '1 个外部智能体在本工作室之外运行，未计入',
  'note.estimate': '按标价估算，以服务商账单为准',
}
