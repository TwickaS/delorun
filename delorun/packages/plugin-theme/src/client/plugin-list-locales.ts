/** The copy of the Plugins screen's Delorun additions: the Experimental plugins group's control, the on-demand rows and the studio plugins' switches. */

/** English dictionary. */
export const en = {
  'moreAction': 'Show experimental',
  'onDemand': 'Installs on demand',
  'studioRowToggle': 'Turn on {name}',
  'studioRowFailed': 'Not saved',
}

/** A key of the Plugins screen's dictionary. */
export type PluginListLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<PluginListLocaleKey, string> = {
  'moreAction': '显示实验性插件',
  'onDemand': '按需安装',
  'studioRowToggle': '开启{name}',
  'studioRowFailed': '未保存',
}
