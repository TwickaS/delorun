import type { ReactNode } from 'react'
import { RootProvider } from 'fumadocs-ui/provider/next'
import '../globals.css'

export default function ChineseLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hans" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  )
}
