import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships its command and the profile lifecycle shared with Desktop, and its argument parser and plugin
 * command as entries of their own, which a launcher that runs `dsh plugin` in its own process and acts on its exit code
 * imports. Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: {
    bin: 'lib/types/installed-bin.js',
    'profile-boot': 'lib/types/profile-boot.js',
    args: 'lib/types/args.js',
    plugin: 'lib/types/plugin.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
})
