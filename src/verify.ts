// 커밋 직전 게이트 (SPEC 4.4). run.ts와 달리 이 스크립트는 non-zero로 끝나야 한다 —
// 수집을 하지 않으므로 셸에 실패를 알려도 그날 데이터가 날아가지 않고, 알리지 않으면
// push 재시도 루프가 깨진 --replay 결과를 그대로 커밋한다.
import { verifyArchiveIntegrity } from './integrity.ts'

try {
  await verifyArchiveIntegrity()
  console.log('site/data OK')
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  console.log(`::error::site/data validation failed: ${message}`)
  console.error(e)
  process.exitCode = 1
}
