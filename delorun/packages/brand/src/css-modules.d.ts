/** CSS Modules compiled into each consumer's browser bundle. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

/** The brand's plain stylesheets, imported for their side effect. */
declare module '*/tokens.css'

/** Upstream's markdown styles, which the studio build bundles. */
declare module 'katex/dist/katex.min.css'

/** The build-time `process.env` that upstream's store reads; the browser bundle replaces it. */
declare const process: { readonly env: Readonly<Record<string, string | undefined>> }
