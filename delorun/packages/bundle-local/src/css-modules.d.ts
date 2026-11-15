declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'

/** The brand's tokens as text, which the brand injects into the document. */
declare module '*.css?inline' {
  const css: string
  export default css
}
