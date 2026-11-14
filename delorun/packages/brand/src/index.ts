/**
 * Delorun's brand: the tokens, the hex mark and the component set. The components compose upstream's studio
 * primitives for keyboard, focus and accessibility behaviour and add Delorun's look and API. The package exports its
 * source: a Delorun studio plugin's browser bundle inlines it, and the website and the docs import it through Vite.
 * It needs no Cordis host. Importing this module adds the `tokens.css` rules to the document; load `fonts.css` as well where the page does not
 * already provide Schibsted Grotesk and JetBrains Mono.
 * @module @delorun/brand
 */
import './tokens-style.ts'

export { BRAND_COLOURS, BRAND_FONTS, BRAND_RADII, BRAND_SPACE } from './tokens.ts'
export { MARK, Mark } from './mark.tsx'
export { Button, type ButtonProps, type ButtonVariant } from './components/Button.tsx'
export { Card, type CardProps } from './components/Card.tsx'
export { ConfirmAction, type ConfirmActionProps } from './components/ConfirmAction.tsx'
export { Dialog, type DialogProps } from './components/Dialog.tsx'
export { Keypad, type KeypadProps } from './components/Keypad.tsx'
export { Link } from './components/Link.tsx'
export { Notice, type NoticeIcon, type NoticeProps, type NoticeTone } from './components/Notice.tsx'
export { OutcomePanel, type OutcomePanelProps } from './components/OutcomePanel.tsx'
export { PinDots, type PinDotsProps } from './components/PinDots.tsx'
export { Pill, type PillProps } from './components/Pill.tsx'
export { StatusCard, type StatusCardProps } from './components/StatusCard.tsx'
export { TextField, type TextFieldProps } from './components/TextField.tsx'
