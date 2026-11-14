/**
 * Reasoning effort as bars, T3 Code's other effort display: upstream's model
 * picker marks its effort caption with the chosen level's place and the
 * level count (`data-effort-level`, `data-effort-levels`), and while
 * `<html>` carries {@link EFFORT_ATTRIBUTE} this style draws the caption as
 * that many bars with the chosen ones filled. The caption's text stays in the
 * trigger's accessible name.
 * @module @delorun/plugin-theme/client/effort
 */

/** The `<html>` attribute that turns the bars on, set to `bars`. */
export const EFFORT_ATTRIBUTE = 'data-delorun-effort'

/** The most levels a model's effort list is drawn for; a longer list keeps its caption. */
const MAX_LEVELS = 8

/** One bar's width and the gap after it, in pixels. */
const BAR = { width: 3, gap: 2 } as const

/**
 * The bars' style.
 * @returns the CSS text.
 */
export function effortBarsCss(): string {
  const on = `html[${EFFORT_ATTRIBUTE}='bars']`
  const counts = Array.from({ length: MAX_LEVELS }, (_, index) => index + 1)
  const step = BAR.width + BAR.gap
  return [
    ...counts.map(n => `${on} [data-effort-levels='${String(n)}']{--delorun-effort-levels:${String(n)}}`),
    ...counts.map(n => `${on} [data-effort-level='${String(n)}']{--delorun-effort-level:${String(n)}}`),
    `${on} [data-effort-level][data-effort-levels]{display:inline-block;flex:none;font-size:0;height:10px;vertical-align:middle;`
    + `width:calc(var(--delorun-effort-levels) * ${String(step)}px - ${String(BAR.gap)}px);`
    + `background:linear-gradient(to right,currentColor calc(var(--delorun-effort-level) * ${String(step)}px),`
    + `color-mix(in srgb,currentColor 28%,transparent) 0);`
    + `mask:repeating-linear-gradient(to right,currentColor 0 ${String(BAR.width)}px,transparent ${String(BAR.width)}px ${String(step)}px)}`,
  ].join('\n')
}
