import { describe, expect, it } from 'vitest'
import { erasableSyntaxErrors, unerasableForms } from '../../src/checks/gates/erasable-syntax.ts'
import { scratchRepo } from './support.ts'

describe('gates:erasable-syntax', () => {
  it('passes sources that use only erasable syntax', () => {
    const text = [
      'import type { A } from \'./a.ts\'',
      'declare enum Ambient { One }',
      'declare namespace Types { const x: number }',
      'namespace OnlyTypes { export interface I { a: string } export type T = I }',
      'export class Error2 extends Error {',
      '  readonly code: string',
      '  constructor(code: string, private: number) { super(code); this.code = code }',
      '}',
      'export const value = <T,>(x: T): T => x',
      'export const cast = 1 as number',
      'import type Fs = require(\'node:fs\')',
      'export default Ambient',
      'declare module \'x\'',
      'namespace Bodyless',
    ].join('\n')
    expect(unerasableForms('ok.ts', text)).toEqual([])
  })

  it('names each form Node\'s type stripping rejects, with its position', () => {
    const text = [
      'export class A { constructor(readonly code: string) {} }',
      'export class B { constructor(private x: number, public y: number, protected z: number, override readonly w: number) { } }',
      'export enum E { One }',
      'export const enum F { One }',
      'export namespace N { export const x = 1 }',
      'import fs = require(\'node:fs\')',
      'export = fs',
      'export const c = <number>JSON.parse(\'1\')',
    ].join('\n')
    const found = unerasableForms('bad.ts', text)
    expect(found.map(message => message.split(': ')[0])).toEqual(['1:30', '2:30', '2:49', '2:67', '2:88', '3:1', '4:1', '5:1', '6:1', '7:1', '8:18'])
    expect(found[0]).toContain('constructor parameter property')
    expect(found.join('\n')).toContain('an enum')
    expect(found.join('\n')).toContain('a namespace that holds values')
    expect(found.join('\n')).toContain('an `import x = ...`')
    expect(found.join('\n')).toContain('an `export =`')
    expect(found.join('\n')).toContain('an angle-bracket assertion')
  })

  it('reads a nested value namespace and a tsx source', () => {
    expect(unerasableForms('n.ts', 'namespace A.B { export const x = 1 }\nnamespace C { namespace D { export type T = 1 } }')).toHaveLength(1)
    expect(unerasableForms('c.tsx', 'export class C { constructor(readonly a: string) {} }\nexport const el = <div />')).toHaveLength(1)
  })

  it('scans delo/ and skips dependency trees, build output, hidden directories and declarations', (test) => {
    const repo = scratchRepo(test)
    const bad = 'export class A { constructor(readonly code: string) {} }\n'
    repo.write({
      'delo/packages/home/src/errors.ts': bad,
      'delo/packages/home/node_modules/dep/index.ts': bad,
      'delo/packages/home/lib/index.ts': bad,
      'delo/packages/home/.cache/index.ts': bad,
      'delo/packages/home/src/types.d.ts': bad,
      'delo/packages/home/src/types.d.mts': bad,
      'packages/upstream/src/index.ts': bad,
    })
    expect(erasableSyntaxErrors(repo.root)).toEqual([
      'delo/packages/home/src/errors.ts:1:30: a constructor parameter property; declare the field and assign it in the constructor',
    ])
    expect(erasableSyntaxErrors(scratchRepo(test).root)).toEqual(['delo/: no Delo tree at the repository root, so there are no sources to check'])
  })
})
