import { readFileSync } from 'node:fs'
import { createMDX } from 'fumadocs-mdx/next'

// The release tooling's package.json is the one source of the Delo version the pages describe.
const release = JSON.parse(readFileSync(new URL('../release/package.json', import.meta.url), 'utf8'))

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  env: { DELO_VERSION: release.version },
}

export default withMDX(config)
