import { describe, expect, it } from 'vitest'
import { renderHomeErrorPage } from '../src/home-error-page.ts'
import { WslHomeError, type WslHomeFailure } from '../src/wsl-home.ts'

const CODES: readonly WslHomeFailure[] = ['wsl-unavailable', 'wsl-timeout', 'distro-missing', 'delorun-missing', 'home-not-running',
  'status-unreadable', 'link-refused', 'link-unusable', 'exchange-failed', 'forwarding-unreachable', 'version-unreadable', 'home-too-old', 'home-too-new', 'rows-unavailable']

describe('home error page', () => {
  it('says "Update this home" for an older home, with both versions and the command, in English and Chinese', () => {
    const error = new WslHomeError('home-too-old', { distro: 'Ubuntu', version: '0.0.9', range: '>=0.1.0-preview.4 <0.2.0-0' })
    const english = renderHomeErrorPage(error, 'en')
    expect(english).toContain('<h1>Update this home</h1>')
    expect(english).toContain('0.0.9')
    expect(english).toContain('&gt;=0.1.0-preview.4 &lt;0.2.0-0')
    expect(english).toContain('delorun update')
    expect(english).not.toContain('Install the latest')
    const chinese = renderHomeErrorPage(error, 'zh-CN')
    expect(chinese).toContain('lang="zh-CN"')
    expect(chinese).toContain('<h1>请更新此主机</h1>')
    expect(chinese).toContain('0.0.9')
  })

  it('says "Update the app" for a newer home, with both versions and no command to run in the home', () => {
    const error = new WslHomeError('home-too-new', { distro: 'Ubuntu', version: '0.3.0', range: '>=0.1.0-preview.4 <0.2.0-0' })
    const english = renderHomeErrorPage(error, 'en')
    expect(english).toContain('<h1>Update the app</h1>')
    expect(english).toContain('0.3.0')
    expect(english).toContain('Install the latest Delorun desktop app')
    expect(english).not.toContain('delorun update')
    expect(renderHomeErrorPage(error, 'zh-CN')).toContain('<h1>请更新应用</h1>')
  })

  it.each(CODES)('has copy for %s in both languages without a placeholder left over', (code) => {
    for (const language of ['en', 'zh-CN', 'ja']) {
      const page = renderHomeErrorPage(new WslHomeError(code, { distro: 'Ubuntu', version: '1.2.3', range: 'R' }), language)
      expect(page).not.toMatch(/\{\w+\}/u)
      expect(page).toContain('<h1>')
    }
  })

  it('escapes what it prints and loads no script or resource', () => {
    const page = renderHomeErrorPage(new WslHomeError('distro-missing', { distro: '<img src=x onerror=alert(1)>' }), 'en')
    expect(page).not.toContain('<img')
    expect(page).toContain('&lt;img')
    expect(page).not.toMatch(/<(script|link|img)\b/iu)
    expect(page).toContain("default-src 'none'")
  })
})
