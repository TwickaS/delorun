import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships its command and the profile lifecycle shared with Desktop, and its argument parser and plugin
 * command as entries of their own, which a launcher that runs `dsh plugin` in its own process and acts on its exit code
 * imports. Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js', 'lib/types/args.js', 'lib/types/plugin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
})
