import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kstDate, kstMonthKey } from '../src/kst.ts'

// 이 하나가 틀리면 샤드 키가 전부 어긋난다 (TASKS.md §1 완료 기준).
test('kstDate: 04:37 KST 수집 시각이 그날 KST 날짜로 떨어진다', () => {
  assert.equal(kstDate(new Date('2026-07-29T19:37:00Z')), '2026-07-30')
})

test('kstDate: KST 자정 경계', () => {
  assert.equal(kstDate(new Date('2026-07-29T14:59:59Z')), '2026-07-29') // KST 23:59:59
  assert.equal(kstDate(new Date('2026-07-29T15:00:00Z')), '2026-07-30') // KST 00:00:00
})

test('kstDate: UTC 자정은 이미 다음 KST 날짜다', () => {
  assert.equal(kstDate(new Date('2026-07-30T00:00:00Z')), '2026-07-30')
})

test('kstDate: 항상 YYYY-MM-DD 형식', () => {
  assert.match(kstDate(new Date('2026-01-05T03:00:00Z')), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(kstDate(new Date('2026-01-05T03:00:00Z')), '2026-01-05')
})

test('kstMonthKey: KST 자정에 월이 넘어간다', () => {
  assert.equal(kstMonthKey(new Date('2026-07-31T14:59:59Z')), '2026-07')
  assert.equal(kstMonthKey(new Date('2026-07-31T15:00:00Z')), '2026-08')
})

test('kstMonthKey: 연말 롤오버', () => {
  assert.equal(kstMonthKey(new Date('2026-12-31T14:59:59Z')), '2026-12')
  assert.equal(kstMonthKey(new Date('2026-12-31T15:00:00Z')), '2027-01')
})

// collectedDate >= cutoff 문자열 비교가 성립하려면 사전순 == 시간순이어야 한다 (SPEC 6.1).
test('kstDate 문자열 정렬이 시간 정렬과 같다', () => {
  const dates = [
    new Date('2026-09-01T00:00:00Z'),
    new Date('2026-01-15T00:00:00Z'),
    new Date('2026-10-01T00:00:00Z'),
    new Date('2025-12-31T00:00:00Z'),
  ]
  const byString = [...dates].map(kstDate).sort()
  const byTime = [...dates].sort((a, b) => a.getTime() - b.getTime()).map(kstDate)
  assert.deepEqual(byString, byTime)
})
