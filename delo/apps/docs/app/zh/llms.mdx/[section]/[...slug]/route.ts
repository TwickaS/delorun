import { isSection } from '@/site/doc-links.ts'
import { markdownParams, pageMarkdown, pageSlugsOf } from '@/site/markdown.ts'

export const dynamic = 'force-static'

export function generateStaticParams() {
  return markdownParams('zh')
}

export async function GET(_request: Request, { params }: { params: Promise<{ section: string, slug: string[] }> }) {
  const { section, slug } = await params
  const markdown = isSection(section) ? await pageMarkdown(section, pageSlugsOf(slug), 'zh') : undefined
  if (markdown === undefined) return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  return new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
}
