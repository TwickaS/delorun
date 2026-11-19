/**
 * What each Phone powers level lets an unlocked phone do, in one place for the Changes section's access note and the
 * Devices section's choice (`@delorun/bundle-local`, through `@delorun/plugin-changes/phone-powers-locales`). The
 * Careful text follows the controls' levels in `../../access.ts`: a control at `phone-powers` is one Careful refuses.
 */

/** English texts. */
export const en = {
  careful: 'An unlocked phone cannot open a terminal, turn protection off, apply or switch plugin changes, change Delorun\'s own files or undo a change to them, make your copy of Delorun or restart it. It can still undo a plugin\'s change, discard any waiting change and turn protection on. Approvals it gives, such as accepting an MCP server, allowing an external agent or giving a workspace full access, can still start programs outside the sandbox.',
  full: 'An unlocked phone can do everything this computer can, the terminal included, each time with an unlock you entered on the phone. The 15 minutes after you approve a phone never count.',
}

/** Chinese texts. */
export const zh: typeof en = {
  careful: '已解锁的手机不能打开终端、关闭保护、应用或切换插件变更、修改 Delorun 自身的文件或撤销对它们的变更、制作你的 Delorun 副本，也不能重启 Delorun。它仍然可以撤销插件的变更、丢弃任何等待中的变更，以及开启保护。它给出的批准，例如接受 MCP 服务器、允许外部智能体或给工作区完全访问权限，仍可能在沙箱外启动程序。',
  full: '已解锁的手机可以做这台电脑能做的一切，包括终端，每次都需要你在手机上输入的解锁。批准手机后的 15 分钟从不算数。',
}
