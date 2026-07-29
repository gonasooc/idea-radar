export type Flight = {
  text: string
  chunkCount: number
}

export function concatFlight(html: string): Flight {
  const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\[\s\S])*")\s*\]\)/g
  let text = ''
  let chunkCount = 0
  for (const m of html.matchAll(re)) {
    text += JSON.parse(m[1])
    chunkCount++
  }
  return { text, chunkCount }
}

export function sliceBalanced(s: string, start: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let k = start; k < s.length; k++) {
    const c = s[k]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return s.slice(start, k + 1)
    }
  }
  return null
}
