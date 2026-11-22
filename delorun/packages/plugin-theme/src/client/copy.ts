/**
 * Hand-written fixes to upstream's texts that Delorun shows, laid over the
 * generated vocabulary: upstream's casing slips, labels that read better in
 * Delorun's sentence case, the Chinese texts the generator's word swap does
 * not reach, and the plugin manager's install texts, which name `delorun plugin`
 * where upstream names `dsh plugin` and ask for a folder's full path, the only
 * local path the studio's install accepts.
 * @module @delorun/plugin-theme/client/copy
 */

/** English override texts by namespace, then key. */
export const COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  workspace: {
    'groupBy.workspace': 'Workspace',
    'groupBy.workspaceTree': 'Workspace tree',
    'groupBy.flat': 'One list',
    'viewOptions.showArchived': 'All, with archived',
    'search.placeholder': 'Search chats',
  },
  pluginManager: {
    installDescription: 'Enter the plugin\'s package name, its GitHub repository address, or the full path of its folder on this computer.',
    installGuideIdHint: 'The plugin package name is the npm package name (like dsh-xxx or @author/plugin): the part after delorun plugin add, dsh plugin add or pnpm add in a plugin\'s README install command.',
    installPathTemplateHint: 'Replace this with the full path of your plugin\'s folder, starting with / (or a drive letter on Windows). A relative path such as ./my-plugin is refused, because the studio cannot tell which folder it means; delorun plugin add accepts one in a terminal.',
    reasonStopProfile: 'This profile runs without HMR; stop Delorun and uninstall the package with delorun plugin remove.',
  },
}

/** Chinese override texts by namespace, then key. */
export const COPY_ZH: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  workspace: {
    'menu.sessionId': '复制对话 ID',
  },
  conversation: {
    'detail.trace.ancestors': '上级对话',
    'detail.trace.descendants': '下级对话',
  },
  pluginManager: {
    installDescription: '输入插件的包名、GitHub 仓库地址，或插件文件夹在本机上的完整路径。',
    installGuideIdHint: '插件包名即 npm 包名（如 dsh-xxx 或 @作者/插件名），插件 README 安装命令中 delorun plugin add、dsh plugin add 或 pnpm add 之后的部分。',
    installPathTemplateHint: '请替换为插件文件夹的完整路径，以 / 开头（Windows 上以盘符开头）。./my-plugin 这样的相对路径会被拒绝，因为工作室无法判断它指的是哪个文件夹；在终端中 delorun plugin add 可以使用相对路径。',
    reasonStopProfile: '这个 profile 没有启用 HMR，请停止 Delorun 后用 delorun plugin remove 卸载这个包。',
  },
}
