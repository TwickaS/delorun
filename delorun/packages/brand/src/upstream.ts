/**
 * The upstream studio primitives the brand components compose: `Button`, `Input`, `Modal`, `Pill` and `Switch`. This is the studio build's choice of `#upstream`; the
 * website and the docs resolve `#upstream` to `upstream.web.tsx`, because upstream's primitives pull in the studio's
 * stores and syntax highlighting, which a static site does not carry.
 * @module @delorun/brand/upstream
 */
export { Button, Input, Modal, Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
