// 커밋 직전 게이트 (SPEC 4.4). run.ts와 달리 이 스크립트는 non-zero로 끝나야 한다 —
// 수집을 하지 않으므로 셸에 실패를 알려도 그날 데이터가 날아가지 않고, 알리지 않으면
// push 재시도 루프가 깨진 --replay 결과를 그대로 커밋한다.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, verifyDataDir } from './store.ts'

async function verify(): Promise<void> {
  await verifyDataDir()

  const file = path.join(DATA_DIR, 'manifest.json')
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  if (manifest.schemaVersion !== 1) throw new Error(`manifest.schemaVersion is ${String(manifest.schemaVersion)}, expected 1`)
  if (typeof manifest.updatedAt !== 'string' || Number.isNaN(Date.parse(manifest.updatedAt))) {
    throw new Error(`manifest.updatedAt is not a parseable timestamp: ${String(manifest.updatedAt)}`)
  }
  if (typeof manifest.lastCollectedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.lastCollectedDate)) {
    throw new Error(`manifest.lastCollectedDate is not YYYY-MM-DD: ${String(manifest.lastCollectedDate)}`)
  }
  if (!Array.isArray(manifest.months) || manifest.months.length === 0) {
    throw new Error('manifest.months is empty or not an array')
  }
  if (typeof manifest.sources !== 'object' || manifest.sources === null) {
    throw new Error('manifest.sources is missing')
  }
}

try {
  await verify()
  console.log('site/data OK')
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  console.log(`::error::site/data validation failed: ${message}`)
  console.error(e)
  process.exitCode = 1
}
