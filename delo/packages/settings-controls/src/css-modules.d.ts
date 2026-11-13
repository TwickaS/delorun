/** CSS Modules compiled into each consumer's browser bundle. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
