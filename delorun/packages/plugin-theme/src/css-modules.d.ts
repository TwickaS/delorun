/** CSS Modules compiled into the browser bundle. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

/** Stylesheets the browser bundle compiles to text for a plugin-owned style element. */
declare module '*.css?inline' {
  const css: string
  export default css
}
