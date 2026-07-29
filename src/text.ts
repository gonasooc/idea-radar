export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c: string) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c: string) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

export function truncate300(s: string): string {
  const chars = [...s]
  if (chars.length <= 300) return s
  return chars.slice(0, 299).join('') + '…'
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function clean(s: string): string {
  return truncate300(collapse(decodeEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))))
}
