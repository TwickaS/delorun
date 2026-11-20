import { paneCount, panesOf, type LayoutModel, type LayoutNode, type PaneId } from '../../src/layout/index.ts'

/** A pane id for a spec; ids are Session ids, which are plain strings at runtime. */
export const pane = (id: string): PaneId => id as PaneId

export const MAIN = pane('main')
export const A = pane('a')
export const B = pane('b')
export const C = pane('c')
export const D = pane('d')

/** A compact picture of a layout, for assertions: `H(main:56, V(a:50, b:50):44)`. */
export function show(model: LayoutModel): string {
  const walk = (node: LayoutNode): string => {
    const size = Math.round(node.size * 10) / 10
    if (node.kind === 'leaf') return `${node.panes.map(p => (p === node.active && node.panes.length > 1 ? `*${p}` : p)).join('+')}:${size}`
    return `${node.orientation === 'horizontal' ? 'H' : 'V'}(${node.children.map(walk).join(', ')}):${size}`
  }
  return walk(model.root)
}

/** Assert the invariants every operation keeps. */
export function sizesSumTo100(model: LayoutModel): boolean {
  const check = (node: LayoutNode): boolean =>
    node.kind === 'leaf' || (Math.abs(node.children.reduce((sum, child) => sum + child.size, 0) - 100) < 1e-6 && node.children.every(check))
  return check(model.root)
}

export const count = paneCount
export const order = panesOf
