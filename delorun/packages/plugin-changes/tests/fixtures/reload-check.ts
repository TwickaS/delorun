/**
 * Runs the check before a profile reload once, as the Host's hot reload does, in a process of its own so that a spec can
 * end it: `node --import tsx/esm reload-check.ts <home> <profile directory>`. Prints `checked` when the check returns.
 */
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../../src/index.ts'

const [home, dir] = process.argv.slice(2)
const ctx = new Context()
ctx.provide('tools', { guard: () => () => {} } as never)
// The Host's published resolution lists no link, as after a bundle failed to import.
ctx.provide('pluginPackages', {} as never)
plugin.apply(ctx, { enabled: false, installationBundles: ['@delorun/bundle-local'], restartWaitSeconds: 600 })
await ctx.get('profileReconcileCheck')!.check({ name: 'default', dir, home } as never)
process.stdout.write('checked\n')
await ctx.fiber.dispose()
process.exit(0)
