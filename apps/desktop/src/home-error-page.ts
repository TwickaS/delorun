/** The plain page shown in place of the studio when a WSL home cannot be opened. */

import type { WslHomeError, WslHomeFailure } from './wsl-home.ts'
import { DESKTOP_PRODUCT_NAME } from './identity.ts'

/** One language's copy of the page. `{distro}`, `{version}` and `{range}` are filled from the error's detail. */
interface PageCopy {
  readonly title: string
  readonly retry: string
  readonly messages: Readonly<Record<WslHomeFailure, { readonly title?: string; readonly what: string; readonly fix: string }>>
}

const en: PageCopy = {
  title: 'Delorun cannot open your home in WSL',
  retry: 'Restart the app to try again.',
  messages: {
    'wsl-unavailable': { what: 'Windows could not start WSL.', fix: 'Check that WSL is installed and turned on, then restart the app.' },
    'wsl-timeout': { what: 'WSL did not answer in time.', fix: 'Open the distribution once from the Start menu so it finishes starting, or run "wsl --status" in PowerShell, then restart the app.' },
    'distro-missing': { what: 'The WSL distribution "{distro}" is not installed.', fix: 'Choose a distribution that "wsl -l -q" lists.' },
    'delorun-missing': { what: 'The command "delorun" was not found in "{distro}".', fix: 'Install Delorun inside that distribution, and make sure its folder is on the PATH of a non-interactive shell.' },
    'home-not-running': { what: 'Delorun is not running in "{distro}".', fix: 'Run "delorun start" inside that distribution, then restart the app.' },
    'status-unreadable': { what: 'Delorun in "{distro}" gave an answer this app does not understand.', fix: 'Update Delorun inside that distribution so it matches this app.' },
    'link-refused': { what: 'The home in "{distro}" would not give a sign-in link.', fix: 'Run "delorun open --print" inside that distribution to see why.' },
    'link-unusable': { what: 'The sign-in link from "{distro}" is not for this computer\'s loopback address.', fix: 'Check that the home listens on 127.0.0.1, then restart the app.' },
    'exchange-failed': { what: 'The home in "{distro}" refused the sign-in link. It may have been used already or have expired.', fix: 'Restart the app to get a new link.' },
    'forwarding-unreachable': { what: 'Windows could not reach the home in "{distro}" on this computer.', fix: 'WSL forwards ports to Windows only when "localhostForwarding" is not turned off in .wslconfig. Turn it on, then restart the app.' },
    'version-unreadable': { what: 'The home in "{distro}" reports a version this app cannot read.', fix: 'Update Delorun inside that distribution so it matches this app (needs {range}).' },
    'home-too-old': { title: 'Update this home', what: 'This app works with Delorun {range}, and the home in "{distro}" is version {version}, which is older.', fix: 'Run "delorun update" inside that distribution to update the home, then restart the app. The app does not update the home itself yet.' },
    'home-too-new': { title: 'Update the app', what: 'This app works with Delorun {range}, and the home in "{distro}" is version {version}, which is newer.', fix: 'Install the latest Delorun desktop app, then restart it. Until then, "delorun open" inside the distribution opens the studio in your browser.' },
    'rows-unavailable': { what: 'The home in "{distro}" (version {version}) did not give this app the data its studio starts from.', fix: 'Update Delorun inside that distribution so it matches this app.' },
  },
}

const zh: PageCopy = {
  title: 'Delorun 无法打开你在 WSL 中的主机',
  retry: '请重启应用后重试。',
  messages: {
    'wsl-unavailable': { what: 'Windows 无法启动 WSL。', fix: '请确认已安装并启用 WSL，然后重启应用。' },
    'wsl-timeout': { what: 'WSL 未在规定时间内响应。', fix: '请先从开始菜单打开一次该发行版，待其启动完成，或在 PowerShell 中运行“wsl --status”，然后重启应用。' },
    'distro-missing': { what: '未安装 WSL 发行版“{distro}”。', fix: '请选择“wsl -l -q”列出的发行版。' },
    'delorun-missing': { what: '在“{distro}”中找不到命令“delorun”。', fix: '请在该发行版内安装 Delorun，并确保其所在文件夹在非交互式 shell 的 PATH 中。' },
    'home-not-running': { what: 'Delorun 未在“{distro}”中运行。', fix: '请在该发行版内运行“delorun start”，然后重启应用。' },
    'status-unreadable': { what: '“{distro}”中的 Delorun 返回了本应用无法理解的结果。', fix: '请在该发行版内更新 Delorun，使其与本应用匹配。' },
    'link-refused': { what: '“{distro}”中的主机未提供登录链接。', fix: '请在该发行版内运行“delorun open --print”查看原因。' },
    'link-unusable': { what: '“{distro}”提供的登录链接不是本机回环地址的链接。', fix: '请确认主机监听 127.0.0.1，然后重启应用。' },
    'exchange-failed': { what: '“{distro}”中的主机拒绝了登录链接，它可能已被使用或已过期。', fix: '请重启应用以获取新链接。' },
    'forwarding-unreachable': { what: 'Windows 无法在本机访问“{distro}”中的主机。', fix: '只有在 .wslconfig 中未关闭 localhostForwarding 时，WSL 才会把端口转发给 Windows。请开启后重启应用。' },
    'version-unreadable': { what: '“{distro}”中的主机报告了本应用无法读取的版本。', fix: '请在该发行版内更新 Delorun，使其与本应用匹配（需要 {range}）。' },
    'home-too-old': { title: '请更新此主机', what: '本应用适用于 Delorun {range}，而“{distro}”中的主机版本为 {version}，版本较旧。', fix: '请在该发行版内运行“delorun update”更新主机，然后重启应用。应用暂时不会自行更新主机。' },
    'home-too-new': { title: '请更新应用', what: '本应用适用于 Delorun {range}，而“{distro}”中的主机版本为 {version}，版本较新。', fix: '请安装最新的 Delorun 桌面应用并重启。在此之前，可在该发行版内运行“delorun open”，用浏览器打开工作台。' },
    'rows-unavailable': { what: '“{distro}”中的主机（版本 {version}）没有向本应用提供其界面启动所需的数据。', fix: '请在该发行版内更新 Delorun，使其与本应用匹配。' },
  },
}

/** Copy for the app's languages; the others read English until their copy is written. */
function copyFor(language: string): PageCopy {
  return language.toLowerCase().startsWith('zh') ? zh : en
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function fill(text: string, detail: Readonly<Record<string, string>>): string {
  return text.replaceAll(/\{(\w+)\}/gu, (placeholder, key: string) => detail[key] ?? placeholder)
}

/**
 * Render the error page. All text is escaped; the page loads no script and no resource.
 * @param error - The failure.
 * @param language - Locale id such as `en` or `zh-CN`.
 * @returns a complete HTML document.
 */
export function renderHomeErrorPage(error: WslHomeError, language: string): string {
  const copy = copyFor(language)
  const message = copy.messages[error.code]
  const lang = language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + `<title>${escapeHtml(DESKTOP_PRODUCT_NAME)}</title>`
    + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:12vh auto;padding:0 1.5rem;color:#1b1b1c}'
    + 'h1{font-size:1.4rem}@media(prefers-color-scheme:dark){body{background:#1b1b1c;color:#f9fafb}}</style></head><body>'
    + `<h1>${escapeHtml(message.title ?? copy.title)}</h1><p>${escapeHtml(fill(message.what, error.detail))}</p>`
    + `<p>${escapeHtml(fill(message.fix, error.detail))}</p><p>${escapeHtml(copy.retry)}</p></body></html>`
}
