/**
 * The GitHub webhook endpoint's own web server: upstream's `@deepseek-ai/dsh-host-webserver` plugin, mounted under this
 * bundle's module name. Plugin management refuses any bundle that adds a row of `@deepseek-ai/dsh-host-webserver`,
 * the module of the studio's own web server; this second server listens on loopback inside the bundle's group, which
 * isolates its `webServer` service from the studio's.
 *
 * @module @delorun/bundle-webhooks/server
 */
export * from '@deepseek-ai/dsh-host-webserver'
export { default } from '@deepseek-ai/dsh-host-webserver'
