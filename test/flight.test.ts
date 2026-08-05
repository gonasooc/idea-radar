import { test } from 'node:test'
import assert from 'node:assert/strict'
import { concatFlight, derefText, scanRows, sliceBalanced } from '../src/flight.ts'

test('sliceBalanced: 단순 객체와 배열', () => {
  assert.equal(sliceBalanced('{"a":1}', 0), '{"a":1}')
  assert.equal(sliceBalanced('[1,[2],3]', 0), '[1,[2],3]')
})

test('sliceBalanced: start 오프셋 뒤부터 자른다', () => {
  assert.equal(sliceBalanced('xx{"a":1}yy', 2), '{"a":1}')
  assert.equal(sliceBalanced('"products":[{"id":1}]', '"products":'.length), '[{"id":1}]')
})

// 문자열 안의 중괄호를 깊이로 세면 payload가 조기 종료돼 JSON.parse가 깨진다.
test('sliceBalanced: 문자열 안의 괄호는 세지 않는다', () => {
  const s = '{"a":"}"}'
  assert.equal(sliceBalanced(s, 0), s)
  assert.deepEqual(JSON.parse(sliceBalanced(s, 0)!), { a: '}' })

  const t = '{"a":"[[["}'
  assert.equal(sliceBalanced(t, 0), t)
})

test('sliceBalanced: 이스케이프된 따옴표는 문자열을 닫지 않는다', () => {
  const s = '{"a":"\\""}' // 실제 문자: {"a":"\""}
  assert.equal(sliceBalanced(s, 0), s)
  assert.deepEqual(JSON.parse(sliceBalanced(s, 0)!), { a: '"' })
})

// \\ 다음의 " 는 진짜 종료 따옴표다. esc 플래그를 리셋하지 않으면 여기서 어긋난다.
test('sliceBalanced: 이스케이프된 역슬래시 뒤의 따옴표는 문자열을 닫는다', () => {
  const s = '{"a":"\\\\"}' // 실제 문자: {"a":"\\"}  (값은 역슬래시 하나)
  assert.equal(sliceBalanced(s, 0), s)
  assert.deepEqual(JSON.parse(sliceBalanced(s, 0)!), { a: '\\' })
})

test('sliceBalanced: 중첩 구조', () => {
  const s = '{"a":{"b":[{"c":"}"}]},"d":2}'
  assert.equal(sliceBalanced(s, 0), s)
  assert.deepEqual(JSON.parse(sliceBalanced(s, 0)!), { a: { b: [{ c: '}' }] }, d: 2 })
})

test('sliceBalanced: 뒤에 쓰레기가 붙어 있어도 균형점에서 끊는다', () => {
  assert.equal(sliceBalanced('{"a":1},"b":2,junk', 0), '{"a":1}')
})

// 균형이 안 맞으면 잘린 문자열을 반환하지 말고 null이어야 한다.
// 부분 문자열을 반환하면 호출부의 JSON.parse가 엉뚱한 예외를 던진다.
test('sliceBalanced: 균형이 안 맞으면 null', () => {
  assert.equal(sliceBalanced('{"a":1', 0), null)
  assert.equal(sliceBalanced('{"a":"unterminated', 0), null)
  assert.equal(sliceBalanced('', 0), null)
})

test('concatFlight: 청크를 순서대로 이어붙인다', () => {
  const html = '<script>self.__next_f.push([1,"ab"])</script><script>self.__next_f.push([1,"cd"])</script>'
  assert.deepEqual(concatFlight(html), { text: 'abcd', chunkCount: 2 })
})

test('concatFlight: 청크 안의 이스케이프를 풀어 준다', () => {
  const html = 'self.__next_f.push([1,"{\\"a\\":1}"])'
  assert.deepEqual(concatFlight(html), { text: '{"a":1}', chunkCount: 1 })
})

test('concatFlight: 공백이 있는 push 형태도 잡는다', () => {
  assert.equal(concatFlight('self.__next_f.push([1,  "x"  ])').chunkCount, 1)
})

// 청크가 0개면 chunkCount로 감지돼야 한다. 컬렉터들이 이 값으로 파싱 붕괴를 판정한다.
test('concatFlight: 청크가 없으면 chunkCount 0', () => {
  assert.deepEqual(concatFlight('<html>no flight here</html>'), { text: '', chunkCount: 0 })
})

test('scanRows: 개행으로 끝나는 일반 행을 읽는다', () => {
  const rows = scanRows('1:"a"\n2:I[123]\n3:{"x":1}\n')
  assert.equal(rows.get('1'), '"a"')
  assert.equal(rows.get('2'), 'I[123]')
  assert.equal(rows.get('3'), '{"x":1}')
})

// hint 행은 ID가 비어 있다(`:HL[...]`). `[0-9a-f]+`로 받으면 여기서 스캔이 멈춰
// 뒤쪽의 T행을 통째로 놓친다 — 실제 일딴 페이로드가 이 형태다.
test('scanRows: 빈 행 ID에서 멈추지 않는다', () => {
  const rows = scanRows(':HL["/a.css","style"]\n1e:T4,abcd\n')
  assert.equal(rows.get('1e'), 'abcd')
})

// T의 길이는 바이트다. 한글은 UTF-8에서 글자당 3바이트라, 같은 수를 문자 수로 읽으면
// 본문이 다음 행까지 넘어간다. 아래 픽스처는 그 차이가 드러나도록 만든 것이다 —
// '안녕하세요'는 5글자 15바이트이므로, 문자 기준으로 15를 세면 '1f:T2,ok'까지 먹는다.
test('scanRows: T행 길이는 문자가 아니라 바이트다', () => {
  const rows = scanRows('1e:Tf,안녕하세요1f:T2,ok')
  assert.equal(rows.get('1e'), '안녕하세요')
  assert.equal(rows.get('1f'), 'ok')
})

// T행 뒤에는 구분자가 없다. 선언된 바이트가 끝나는 자리에서 다음 행이 바로 시작한다.
test('scanRows: T행 뒤에 개행 없이 다음 행이 붙어도 읽는다', () => {
  const rows = scanRows('1e:T3,abc1f:T3,def')
  assert.equal(rows.get('1e'), 'abc')
  assert.equal(rows.get('1f'), 'def')
})

test('scanRows: T 본문 안의 개행은 행을 끝내지 않는다', () => {
  const rows = scanRows('1e:T9,a\r\n\r\nbcde\n2:"x"\n')
  assert.equal(rows.get('1e'), 'a\r\n\r\nbcde')
  assert.equal(rows.get('2'), '"x"')
})

test('scanRows: 형식이 깨져도 그 앞까지는 돌려준다', () => {
  const rows = scanRows('1:"a"\n!!!garbage')
  assert.equal(rows.get('1'), '"a"')
  assert.equal(rows.size, 1)
})

test('derefText: 참조를 본문으로 바꾼다', () => {
  const rows = scanRows('1e:T5,hello\n')
  assert.equal(derefText('$1e', rows), 'hello')
})

// `$`로 시작하지 않는 값은 손대지 않는다. 가공 금지 원칙상 통과값은 바이트 그대로여야 한다.
test('derefText: 센티널이 아니면 원본 그대로', () => {
  const rows = scanRows('1e:T5,hello\n')
  assert.equal(derefText('보통 설명', rows), '보통 설명')
  assert.equal(derefText('가격은 $100 부터', rows), '가격은 $100 부터')
  assert.equal(derefText('', rows), '')
})

// 해석 실패에 원본(`$1e`)을 돌려주면 호출부가 그걸 그대로 저장한다. 반드시 undefined다.
test('derefText: 없는 행이면 undefined', () => {
  assert.equal(derefText('$ff', scanRows('1e:T5,hello\n')), undefined)
  assert.equal(derefText(undefined, scanRows('')), undefined)
  assert.equal(derefText(42, scanRows('')), undefined)
})

// 행 참조는 `$` 센티널의 한 종류일 뿐이다. 나머지를 "참조가 아니니 원본 그대로"로 흘리면
// `$undefined`가 설명으로 저장되고, 항목은 불변이라 손으로 데이터를 고치는 수밖에 없다.
test('derefText: 행 참조가 아닌 값 센티널도 저장하지 않는다', () => {
  const rows = scanRows('1e:T5,hello\n')
  assert.equal(derefText('$undefined', rows), undefined)
  assert.equal(derefText('$D2026-08-05T00:00:00.000Z', rows), undefined)
  assert.equal(derefText('$n9007199254740993', rows), undefined)
  assert.equal(derefText('$Infinity', rows), undefined)
  assert.equal(derefText('$notahexref', rows), undefined)
  assert.equal(derefText('$1e 로 시작하는 문장', rows), undefined)
  assert.equal(derefText('$', rows), undefined)
})

// 진짜 `$`로 시작하는 문자열은 `$`를 하나 덧붙여 escape 되어 온다. 안 풀면 달러가 겹친 채 박힌다.
test('derefText: escape 된 리터럴 $ 를 되돌린다', () => {
  const rows = scanRows('1e:T5,hello\n')
  assert.equal(derefText('$$100 부터 시작하는 정산 서비스', rows), '$100 부터 시작하는 정산 서비스')
  assert.equal(derefText('$$1e', rows), '$1e')
  assert.equal(derefText('$$', rows), '$')
})
