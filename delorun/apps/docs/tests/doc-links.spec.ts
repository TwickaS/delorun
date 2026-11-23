import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DELORUN_BLOB_URL, resolveLink, UPSTREAM_BLOB_URL } from '../src/site/doc-links.ts'

/** The repository root, from this spec's folder `delorun/apps/docs/tests`. */
const root = resolve(import.meta.dirname, '../../../..')
const page = (path: string) => join(root, 'delorun/docs', path)

describe('a link in a published page', () => {
  it('becomes the route of a published page, in the locale its suffix names', () => {
    expect(resolveLink(page('guide/help/questions.md'), '../safety-and-updates/trust.md#outside-security-review', root)).toEqual({ kind: 'href', href: '/guide/safety-and-updates/trust#outside-security-review' })
    expect(resolveLink(page('guide/help/questions.zh.md'), '../safety-and-updates/trust.zh.md', root)).toEqual({ kind: 'href', href: '/zh/guide/safety-and-updates/trust' })
  })

  it("opens a top-level file such as SECURITY.md, GOVERNANCE.md or SUPPORT.md in Delorun's repository, which is the only one that has them", () => {
    for (const file of ['SECURITY.md', 'GOVERNANCE.md', 'SUPPORT.md']) {
      expect(resolveLink(page('guide/help/questions.md'), `../../../../${file}`, root)).toEqual({ kind: 'href', href: `${DELORUN_BLOB_URL}${file}` })
    }
    expect(resolveLink(page('guide/customising/customise.md'), '../../../../AGENTS.md#the-fork-boundary', root)).toEqual({ kind: 'href', href: `${DELORUN_BLOB_URL}AGENTS.md#the-fork-boundary` })
  })

  it("opens a Delorun file the site does not publish, such as a contract, in Delorun's repository", () => {
    expect(resolveLink(page('guide/get-started/install.md'), '../../contracts/c02-release-manifest.md', root)).toEqual({ kind: 'href', href: `${DELORUN_BLOB_URL}delorun/docs/contracts/c02-release-manifest.md` })
  })

  it("opens an upstream file below the top level, such as upstream's glossary, in upstream's repository", () => {
    expect(resolveLink(page('reference/README.md'), '../../../docs/glossary.md', root)).toEqual({ kind: 'href', href: `${UPSTREAM_BLOB_URL}docs/glossary.md` })
  })

  it('leaves fragments and absolute URLs as written, and fails on a target that exists nowhere', () => {
    expect(resolveLink(page('guide/README.md'), '#summary', root)).toEqual({ kind: 'href', href: '#summary' })
    expect(resolveLink(page('guide/README.md'), 'https://docs.delorun.com/changelog', root)).toEqual({ kind: 'href', href: 'https://docs.delorun.com/changelog' })
    expect(() => resolveLink(page('guide/README.md'), '../../../NO-SUCH-FILE.md', root)).toThrow('names no file in the repository')
  })
})
