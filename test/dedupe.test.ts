import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertRawItem, dedupeInRun, nativeId } from '../src/run.ts'
import type { RawItem } from '../src/types.ts'

function raw(id: string, title: string): RawItem {
  return { id, source: 'disquiet', title, description: '', url: `https://example.com/${id}` }
}

// seen 인덱스는 네이티브 id로만 저장한다. 소스 키에 하이픈이 들어 있어도
// (geeknews-show) 접두어 길이 계산이 어긋나면 안 된다.
test('nativeId: 소스 접두어를 정확히 벗겨낸다', () => {
  assert.equal(nativeId('showhn', 'showhn:45123'), '45123')
  assert.equal(nativeId('disquiet', 'disquiet:7536'), '7536')
  assert.equal(nativeId('geeknews-show', 'geeknews-show:24680'), '24680')
  assert.equal(nativeId('producthunt', 'producthunt:1234567'), '1234567')
})

test('nativeId: 네이티브 id 안의 콜론·하이픈을 보존한다', () => {
  assert.equal(nativeId('syde', 'syde:0f8c1a2b-3d4e-5f60-8a9b-0c1d2e3f4a5b'), '0f8c1a2b-3d4e-5f60-8a9b-0c1d2e3f4a5b')
  assert.equal(nativeId('jocohunt', 'jocohunt:my-product_1'), 'my-product_1')
})

test('nativeId: 잘못된 소스 접두어나 빈 네이티브 id를 거부한다', () => {
  assert.throws(() => nativeId('disquiet', 'syde:123'), /does not start/)
  assert.throws(() => nativeId('disquiet', 'disquiet:'), /no native id/)
})

test('assertRawItem: 공통 스키마 위반을 컬렉터 단계에서 거부한다', () => {
  assert.doesNotThrow(() => assertRawItem('disquiet', raw('disquiet:1', '정상')))
  assert.throws(() => assertRawItem('disquiet', { ...raw('disquiet:1', '정상'), source: 'syde' }), /has source/)
  assert.throws(() => assertRawItem('disquiet', { ...raw('disquiet:1', '정상'), url: 'javascript:alert(1)' }), /invalid url/)
  assert.throws(() => assertRawItem('disquiet', { ...raw('disquiet:1', '정상'), publishedAt: 'not-a-date' }), /invalid publishedAt/)
})

// 기록된 항목은 불변이다 (CLAUDE.md 5). 같은 id를 다시 보면 나중 것으로 덮어쓰지 않고
// 먼저 나온 것을 채택한다 (SPEC 3의 dedupe 순서 ①).
test('dedupeInRun: 같은 id는 먼저 나온 것을 채택한다', () => {
  const out = dedupeInRun([raw('disquiet:1', '먼저'), raw('disquiet:2', '다른 것'), raw('disquiet:1', '나중')])
  assert.equal(out.length, 2)
  assert.equal(out.find((i) => i.id === 'disquiet:1')!.title, '먼저')
})

test('dedupeInRun: 원래 순서를 유지한다', () => {
  const out = dedupeInRun([raw('disquiet:3', 'c'), raw('disquiet:1', 'a'), raw('disquiet:3', 'c2'), raw('disquiet:2', 'b')])
  assert.deepEqual(out.map((i) => i.id), ['disquiet:3', 'disquiet:1', 'disquiet:2'])
})

test('dedupeInRun: 중복이 없으면 그대로 통과', () => {
  const input = [raw('disquiet:1', 'a'), raw('disquiet:2', 'b')]
  assert.deepEqual(dedupeInRun(input), input)
  assert.deepEqual(dedupeInRun([]), [])
})

// run.ts를 import 해도 수집이 시작되면 안 된다 (import.meta.main 가드).
// 이 파일이 import 만으로 네트워크를 치지 않고 끝나는 것 자체가 그 증거다.
test('run.ts는 import 만으로 실행되지 않는다', () => {
  assert.equal(typeof dedupeInRun, 'function')
  assert.equal(typeof nativeId, 'function')
})
