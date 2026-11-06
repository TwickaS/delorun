import type { ReactNode } from 'react'
import { RootProvider } from 'fumadocs-ui/provider/next'
import '../globals.css'

export default function EnglishLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  )
}
