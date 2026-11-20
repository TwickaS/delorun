/**
 * The studio half of the Browser choice, a library a plugin's browser bundle inlines: the `BrowserChoices` component
 * and its copy, beside the readiness reader of the package's root.
 * @module @delorun/browser-setup/client
 */
export { BROWSER_BUNDLE, REAL_BROWSER_BUNDLE, browserAdded, browserPageState, resolveBrowserSwitch, type BrowserFailure, type BrowserPageInput, type BrowserPageState, type BrowserSwitch, type PackProgress, browserReadinessOf, createBrowserSetup, type BrowserReadiness, type BrowserSetupStore, type RequirementFix } from '../index.ts'
export { BrowserChoices, BrowserCommand, type BrowserChoice, type BrowserChoicesProps, type BrowserTranslate } from './BrowserChoices.tsx'
export { en, zh, type BrowserSetupLocaleKey } from './locales.ts'
