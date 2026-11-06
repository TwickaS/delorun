import { llmsIndex } from '@/site/markdown.ts'

export const dynamic = 'force-static'

export async function GET() {
  return new Response(await llmsIndex('zh'), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
