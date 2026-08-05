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

export type FlightRows = ReadonlyMap<string, string>

// RSC flight는 JSON이 아니라 `{행ID}:{값}` 레코드의 나열이다. 긴 문자열은 인라인되지 않고
// 별도 행(`{id}:T{길이},{본문}`)으로 빠지고, 원래 자리에는 `"$1e"` 같은 참조만 남는다.
// 그래서 sliceBalanced로 뽑은 객체만 보면 본문이 통째로 비어 있다.
//
// 두 가지를 실측으로 확인하고 쓴 것이다 (2026-08-05, ilddan.com/market?cat=web):
//  · T의 길이는 **바이트**다. `1e:T1243,` = 4675바이트 = 2647자. 문자 수로 자르면 한글에서
//    다음 행을 먹는다.
//  · T행 뒤에는 구분자가 없다. 선언된 바이트가 끝나는 그 자리에서 다음 행이 바로 시작한다.
//    그래서 `\n`으로 split 하면 안 되고 앞에서부터 순차 스캔해야 한다.
// 행 ID는 비어 있을 수 있다(`:HL[...]` 같은 hint 행). `[0-9a-f]*`로 받아야 스캔이 멈추지 않는다.
export function scanRows(flight: string): FlightRows {
  const rows = new Map<string, string>()
  let i = 0
  while (i < flight.length) {
    const head = /^([0-9a-f]*):/.exec(flight.slice(i, i + 16))
    if (!head) break // 형식이 어긋나면 여기까지만 인정한다. 부분 표도 참조 해석에는 쓸 수 있다.
    const id = head[1]
    const p = i + head[0].length
    const text = /^T([0-9a-f]+),/.exec(flight.slice(p, p + 16))
    if (text) {
      const byteLen = parseInt(text[1], 16)
      const start = p + text[0].length
      // UTF-8은 문자당 최소 1바이트이므로 byteLen 문자만 떼어내면 본문이 반드시 그 안에 있다.
      // flight 전체를 매 행마다 인코딩하지 않기 위한 상한이다.
      const window = flight.slice(start, start + byteLen)
      const body = Buffer.from(window, 'utf8').subarray(0, byteLen).toString('utf8')
      if (!rows.has(id)) rows.set(id, body)
      i = start + body.length
      if (flight[i] === '\n') i++
      continue
    }
    const nl = flight.indexOf('\n', p)
    const end = nl === -1 ? flight.length : nl
    if (!rows.has(id)) rows.set(id, flight.slice(p, end))
    i = end + 1
  }
  return rows
}

const TEXT_REF = /^\$([0-9a-f]+)$/

// flight 모델에서 `$`로 시작하는 문자열은 **전부** 센티널이다. 행 참조(`$1e`)는 그중 하나일 뿐이고
// `$undefined`, `$D2026-…`(Date), `$n…`(BigInt), `$Infinity` 같은 값 센티널이 같은 자리에 온다.
// 그래서 "행 참조만 알고 나머지는 그대로 통과"시키면 `$undefined`가 설명으로 저장된다 —
// 항목은 불변이라(SPEC 2.2) 한 번 들어가면 손으로 데이터를 고치는 것 말고 되돌릴 방법이 없다.
// 실제로 `$1e`가 그렇게 박혔던 게 2026-08-05 수리 건이고, 이 함수는 그 클래스 전체를 막는다.
//
// 진짜 `$`로 시작하는 문자열은 직렬화 때 `$`를 하나 덧붙여 escape 되므로(`$100` → `$$100`)
// 여기서 되돌린다. 그 외 알 수 없는 센티널은 undefined다 — 텍스트로 쓸 수 없는 값을
// 호출부가 저장하는 일이 없도록 강제하기 위해서다.
export function derefText(value: unknown, rows: FlightRows): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!value.startsWith('$')) return value
  if (value.startsWith('$$')) return value.slice(1)
  const m = TEXT_REF.exec(value)
  if (!m) return undefined
  return rows.get(m[1])
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
