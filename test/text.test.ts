import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clean, collapse, decodeEntities, truncate300 } from '../src/text.ts'

// &amp;를 마지막에 치환하는 순서가 핵심이다. 먼저 치환하면 &amp;lt;가 <로 붕괴해
// 원문에 있던 이스케이프가 사라진다. 이 테스트가 그 순서를 고정한다.
test('decodeEntities: &amp;는 마지막에 치환된다', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;')
  assert.equal(decodeEntities('&amp;amp;'), '&amp;')
  assert.equal(decodeEntities('&amp;quot;'), '&quot;')
})

test('decodeEntities: 명명 엔티티', () => {
  assert.equal(decodeEntities('a&quot;b&apos;c&lt;d&gt;e&amp;f'), 'a"b\'c<d>e&f')
  assert.equal(decodeEntities('a&nbsp;b'), 'a b')
})

test('decodeEntities: 숫자 엔티티 (10진·16진)', () => {
  assert.equal(decodeEntities('&#39;'), "'")
  assert.equal(decodeEntities('&#x27;'), "'")
  assert.equal(decodeEntities('&#xAC00;'), '가')
  assert.equal(decodeEntities('&#128512;'), '😀')
})

test('decodeEntities: 엔티티가 없으면 그대로', () => {
  assert.equal(decodeEntities('평범한 제목 - Show GN'), '평범한 제목 - Show GN')
})

// UTF-16 단위가 아니라 코드포인트로 세야 한다. 아니면 이모지가 반토막 나 깨진 문자가 저장된다.
test('truncate300: 코드포인트 단위로 센다', () => {
  assert.equal([...truncate300('가'.repeat(301))].length, 300)

  // 이모지는 UTF-16 2단위다. 단위로 세면 150개에서 잘리고, 더 나쁘게는 서로게이트가 반토막 난다.
  const chars = [...truncate300('😀'.repeat(301))]
  assert.equal(chars.length, 300)
  assert.equal(chars[299], '…')
  assert.ok(chars.slice(0, 299).every((c) => c === '😀')) // 반토막 난 서로게이트가 없다
})

test('truncate300: 300자 이하는 건드리지 않는다', () => {
  const exact = '가'.repeat(300)
  assert.equal(truncate300(exact), exact)
  assert.equal(truncate300(''), '')
  assert.equal(truncate300('짧은 제목'), '짧은 제목')
})

test('collapse: 공백 정규화와 트림', () => {
  assert.equal(collapse('  a \n\t b  '), 'a b')
  assert.equal(collapse('\n\n'), '')
})

test('clean: 태그 제거 → 엔티티 디코드 → 공백 정규화', () => {
  assert.equal(clean('<p>a<br>b</p>'), 'a b')
  assert.equal(clean('<br/>'), '')
  assert.equal(clean('  <b>Hello</b>&nbsp;&amp;  World  '), 'Hello & World')
})

// <br>을 먼저 공백으로 바꾸지 않으면 두 줄이 한 단어로 붙는다.
test('clean: <br>은 공백이 되고 다른 태그는 사라진다', () => {
  assert.equal(clean('첫줄<br>둘째줄'), '첫줄 둘째줄')
  assert.equal(clean('<span>첫줄</span><span>둘째줄</span>'), '첫줄둘째줄')
})

test('clean: 300자 절단까지 적용된다', () => {
  assert.equal([...clean('<p>' + '가'.repeat(400) + '</p>')].length, 300)
})
