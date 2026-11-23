/** CSS Modules compiled into the browser bundle. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

/** Plain style sheets, imported for their side effect (the shared settings controls import the brand tokens). */
declare module '*.css'
