/**
 * The upstream primitives the real studio sections import, each from its own source file. The replica's build answers
 * those sections' bare `@deepseek-ai/dsh-client-ui-primitives` import with this module (`build/plugins.ts`), so they
 * never reach upstream's package entry and its KaTeX, Shiki and markdown imports.
 * @module @delorun/website/replica/studio/primitives
 */
export { Button } from '#studio/ui-primitives/src/Button.tsx'
export { Checkbox } from '#studio/ui-primitives/src/Checkbox.tsx'
export { CommandText } from '#studio/ui-primitives/src/CommandText.tsx'
export { Input } from '#studio/ui-primitives/src/Input.tsx'
export { observeComposition } from '#studio/ui-primitives/src/keyboard-composition.ts'
export { MenuSurface } from '#studio/ui-primitives/src/MenuSurface.tsx'
export { Modal } from '#studio/ui-primitives/src/Modal.tsx'
export { usePointerGrace } from '#studio/ui-primitives/src/pointer-grace.ts'
export { relativeTime } from '#studio/ui-primitives/src/relative-time.ts'
export { StateDot } from '#studio/ui-primitives/src/StateDot.tsx'
export { Switch } from '#studio/ui-primitives/src/Switch.tsx'
export { Tag } from '#studio/ui-primitives/src/Tag.tsx'
export { useDismissOnOutsidePointer } from '#studio/ui-primitives/src/useDismissOnOutsidePointer.ts'
export { IconWarningOutlineRegular } from './icons.tsx'
export { isBehindModal } from './modal-layer.ts'
