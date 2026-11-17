import { describe, expect, it } from 'vitest'
import { median } from '../review/audit.ts'
import { expected, headFindings, readHeadTags } from '../review/head-tags.ts'
import { parsePictureName, passFolder, pictureName } from '../review/naming.ts'
import { auditMarkdown, indexMarkdown, reportJson, summarise, summaryLines, type Report } from '../review/report.ts'

describe('picture names', () => {
  const spec = { page: 'home', section: 'make-it-yours', width: 1440, look: 'ember', scheme: 'dark', state: 'k-03' } as const

  it('carry page, section, width, look, scheme and state', () => {
    expect(pictureName(spec)).toBe('home__make-it-yours__w1440__ember-dark__k-03.png')
  })

  it('read back to the same parts', () => {
    expect(parsePictureName(pictureName(spec))).toEqual(spec)
  })

  it('are the same for the same input', () => {
    expect(pictureName(spec)).toBe(pictureName({ ...spec }))
  })

  it('refuse a name that does not follow the scheme', () => {
    expect(parsePictureName('shot.png')).toBeUndefined()
  })

  it('turn awkward words into plain slugs', () => {
    expect(pictureName({ ...spec, section: "What's new" })).toContain('__what-s-new__')
  })
})

describe('pass folder', () => {
  it('names the folder by pass number', () => {
    expect(passFolder('/r/', 2)).toBe('/r/site-pass-2')
  })

  it('refuses pass 0', () => {
    expect(() => passFolder('/r', 0)).toThrow(/from 1/)
  })
})

describe('report', () => {
  const report: Report = {
    pass: 1,
    commit: 'abc',
    missingSections: ['phone'],
    findings: [
      { severity: 'fail', check: 'overflow', where: '390', message: 'wider by 12 px' },
      { severity: 'fail', check: 'axe', where: 'home', message: 'color-contrast 3.1:1' },
      { severity: 'fail', check: 'axe', where: 'home', message: 'label' },
      { severity: 'warn', check: 'tap-target', where: '390', message: '20x20' },
    ],
    measurements: { lcpMs: 1800 },
    pictures: ['home__page__w390__soft-light__default.png'],
  }

  it('counts failures by check', () => {
    expect(summarise(report)).toMatchObject({ fail: 3, warn: 1, pictures: 1, missingSections: 1, failsByCheck: { axe: 2, overflow: 1 } })
  })

  it('prints the summary lines', () => {
    expect(summaryLines(summarise(report))).toEqual(['pictures: 1', 'failures: 3 (axe 2, overflow 1)', 'warnings: 1', 'missing sections: 1'])
  })

  it('writes json with the summary first and parseable', () => {
    const parsed = JSON.parse(reportJson(report)) as Record<string, unknown>
    expect(Object.keys(parsed)[0]).toBe('summary')
    expect(parsed['pass']).toBe(1)
  })

  it('writes the audit with each check and the missing sections', () => {
    const text = auditMarkdown(report)
    expect(text).toContain('## Missing sections')
    expect(text).toContain('## axe')
    expect(text).toContain('**fail** (390): wider by 12 px')
  })

  it('lists the pictures grouped by page', () => {
    expect(indexMarkdown(['home__a__w1__soft-light__default.png', '404__page__w1__soft-light__default.png'])).toMatch(/## 404[\s\S]*## home/)
  })
})

describe('head tag expectations', () => {
  it('does not require canonical or og:url on the noindex 404 page, nor structured data off the home page', () => {
    expect(expected('404', 'canonical')).toBe(false)
    expect(expected('404', 'og:url')).toBe(false)
    expect(expected('privacy', 'structured-data')).toBe(false)
    expect(expected('home', 'structured-data')).toBe(true)
    expect(expected('privacy', 'canonical')).toBe(true)
  })
})

describe('head tags', () => {
  const html = `<html><head><title>Delorun</title><meta name="description" content="A harness."><link rel="canonical" href="https://delorun.com/"><meta property="og:title" content="Delorun"><meta property="og:image" content=""><meta name="twitter:card" content="summary_large_image"><script type="application/ld+json">{"@type":"SoftwareApplication"}</script></head><body></body></html>`

  it('reads what is present and marks the rest missing', () => {
    const tags = readHeadTags(html)
    expect(tags.title).toBe('Delorun')
    expect(tags.canonical).toBe('https://delorun.com/')
    expect(tags['twitter:card']).toBe('summary_large_image')
    expect(tags['structured-data']).toBe('SoftwareApplication')
    expect(tags['og:image']).toBeNull()
    expect(tags['og:url']).toBeNull()
  })

  it('warns for each missing tag and fails invalid structured data', () => {
    const findings = headFindings('home', readHeadTags(html))
    expect(findings.some(finding => finding.message === 'og:image is missing')).toBe(true)
    expect(findings.every(finding => finding.severity === 'warn')).toBe(true)
    expect(headFindings('404', readHeadTags('<head></head>')).some(finding => finding.message.startsWith('canonical'))).toBe(false)
    const broken = headFindings('home', readHeadTags('<head><script type="application/ld+json">{</script></head>'))
    expect(broken.some(finding => finding.severity === 'fail')).toBe(true)
  })
})

describe('median', () => {
  it('takes the middle of an odd list and the mean of an even one', () => {
    expect(median([3080, 2196, 2400])).toBe(2400)
    expect(median([10, 20, 30, 40])).toBe(25)
  })
})
