import { test } from 'node:test'
import assert from 'node:assert/strict'
import { concatFlight, sliceBalanced } from '../src/flight.ts'

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
