/** The "How Delorun runs" settings section's copy. */

/** English dictionary. */
export const en = {
  'nav': 'How Delorun runs',
  'title': 'How Delorun runs',
  'intro': 'These choices are made in a terminal on the computer Delorun runs on. Each row shows the command that changes it.',
  'heading': 'Changed in a terminal',
  'command': 'Command',
  'prompts.title': 'How much Delorun asks',
  'prompts.body': 'Choose how often Delorun asks before it changes files or runs commands.',
  'background.title': 'Run in the background',
  'background.body': 'Choose whether Delorun keeps running after the terminal that started it closes.',
  'profile.title': 'Profile name and studio port',
  'profile.body': 'Choose the name of this profile and the port the studio opens on.',
  'reach.title': 'Phone access',
  'reach.body': 'Choose whether you can open the studio from your phone over your private Tailscale network.',
  'reach.on': 'Now: on',
  'reach.off': 'Now: off',
}

/** A key of the "How Delorun runs" dictionary. */
export type SetupCommandsLocaleKey = keyof typeof en

/** Chinese dictionary. */
export const zh: typeof en = {
  'nav': 'Delorun 如何运行',
  'title': 'Delorun 如何运行',
  'intro': '这些选项需要在运行 Delorun 的电脑上用终端设置。每一行都给出了更改它的命令。',
  'heading': '在终端中更改',
  'command': '命令',
  'prompts.title': 'Delorun 询问的频繁程度',
  'prompts.body': '选择 Delorun 在修改文件或运行命令之前询问你的频繁程度。',
  'background.title': '在后台运行',
  'background.body': '选择启动 Delorun 的终端关闭后，Delorun 是否继续运行。',
  'profile.title': '配置名称和工作室端口',
  'profile.body': '选择此配置的名称，以及工作室使用的端口。',
  'reach.title': '手机访问',
  'reach.body': '选择是否通过你的私有 Tailscale 网络在手机上打开工作室。',
  'reach.on': '当前：已开启',
  'reach.off': '当前：未开启',
}
