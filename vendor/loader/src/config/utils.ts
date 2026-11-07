import { valueMap } from '@deepseek-ai/cosmokit'

let evaluator: ((ctx: object, expr: string) => any) | undefined

/**
 * Evaluate a JavaScript expression against a loader context scope. The
 * evaluator is compiled on first use, so importing the Loader performs no
 * string evaluation and a page whose Content Security Policy refuses
 * `'unsafe-eval'` can load it.
 * @param ctx - scope the expression reads names from.
 * @param expr - JavaScript expression source.
 * @returns the expression's value.
 */
export function evaluate(ctx: object, expr: string): any {
  // eslint-disable-next-line no-new-func
  evaluator ??= new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`) as ((ctx: object, expr: string) => any)
  return evaluator(ctx, expr)
}

/** Recursively replace YAML `!!js` expression nodes with evaluated values. */
export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

/** Return true when a value is a serialized loader JavaScript expression. */
export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

/** Serialized JavaScript expression produced by the include YAML tag. */
export interface JsExpr {
  __jsExpr: string
}

/**
 * Find the first `__jsExpr` node in a raw configuration, with its path from the
 * configuration root. The `refuseCode` walk uses it before interpolation, so a
 * refusal happens without evaluating anything.
 * @param value - the raw configuration value to walk.
 * @param base - the path walked to reach `value`.
 * @returns the first expression node's path and source, or `undefined`.
 */
export function findJsExpr(value: unknown, base: (string | number)[] = []): { path: (string | number)[], expr: string } | undefined {
  if (isJsExpr(value)) return { path: [...base], expr: value.__jsExpr }
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findJsExpr(value[index], [...base, index])
      if (found) return found
    }
    return undefined
  }
  for (const [key, item] of Object.entries(value)) {
    const found = findJsExpr(item, [...base, key])
    if (found) return found
  }
  return undefined
}

/** Render a walked path as the property chain after its root label, e.g. `.rows[0].host`. */
export function formatConfigPath(path: readonly (string | number)[]): string {
  return path.map(segment => typeof segment === 'number' ? `[${segment}]` : `.${segment}`).join('')
}
