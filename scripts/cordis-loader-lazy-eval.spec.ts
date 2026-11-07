/** Loader's `!!js` evaluator compiles on first use, so importing the Loader evaluates no string. */
import { afterEach, expect, it, vi } from 'vitest'

const original = globalThis.Function

afterEach(() => {
  globalThis.Function = original
})

it('imports the Loader without compiling a string and compiles the evaluator on the first expression', async () => {
  const compiled: string[] = []
  globalThis.Function = new Proxy(original, {
    construct(target, args: string[]) {
      compiled.push(args.at(-1) ?? '')
      return Reflect.construct(target, args) as object
    },
  })
  vi.resetModules()
  const utils = await import('../vendor/loader/src/config/utils.ts')
  await import('@deepseek-ai/cordis-plugin-loader')
  expect(compiled).toEqual([])

  expect(utils.interpolate({ answer: 41 }, { value: { __jsExpr: 'answer + 1' } })).toEqual({ value: 42 })
  expect(utils.evaluate({ answer: 41 }, 'answer - 1')).toBe(40)
  expect(compiled).toHaveLength(1)
})
