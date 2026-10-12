# W-003 · SYDE 연속 실패와 Disquiet 창 넘침

- 상태: 진행 중
- 최근 갱신: 2026-10-12
- 관련 문서: [docs/README.md](../README.md), [SPEC.md](../../SPEC.md) 4.2·4.5, [spec/sources/2-disquiet.md](../../spec/sources/2-disquiet.md), [spec/sources/3-syde.md](../../spec/sources/3-syde.md)

## 현재 상황

2026-10-12 사용자가 collect 워크플로 #165~#171(10/9~10/12) 연속 실패의 원인을 물었다. 원인은 SYDE 응답 형식 변경이었고, 고쳐서 푸시했다(`2496747`). 조사 중에 별개로 Disquiet가 매주 승인분의 앞 40건만 수집해 7월 이후 607건을 잃어 온 것을 찾았다. 읽는 범위를 바꾸고, 창 넘침을 빨간불로 올리고, 밀린 분량을 되찾는 `--backfill`을 구현해 검증했다. 되찾기는 로컬에서 실행했다(2026-10-12 13:55 KST, 607건). 코드·문서(`069286c`)와 되찾은 데이터(`a5fb6a2`)를 따로 커밋해 푸시했고 Pages 배포까지 확인했다. 따로 커밋한 이유는 데이터 커밋을 되돌리면 아카이브 행을 지우게 되기 때문이다(CLAUDE.md 5). 남은 것은 예약 실행에서의 확인(SYDE 복귀, 다음 승인일 깊은 스캔)이다.

- 완료 조건:
  - SYDE가 예약 실행에서 `[ok]`로 돌아오고 밀린 7건이 들어온다. 빨간불이 꺼진다.
  - `--backfill`로 Disquiet 607건이 아카이브에 들어가고 `node src/verify.ts`가 통과한다.
  - 다음 승인일(2026-10-19 월) 아침 실행에서 Disquiet가 깊게 읽고(`parsed` 수백) 넘침 없이 승인분을 모두 받는다.
- 사람이 판단할 사항:
  - **창 넘침 규칙을 [CLAUDE.md](../../CLAUDE.md) 불변식으로 올릴지.** "고정 범위만 읽는 컬렉터는 창 넘침을 판정하고, 넘치면 빨간불"은 데이터를 잃는 종류의 규칙이다. 지금은 SPEC 4.2·4.5와 [docs/specs.md](../specs.md)에만 있다.
  - **Product Hunt에도 판정을 붙일지.** 91회 실행 중 2회(2026-09-18T21:50Z, 09-25T22:46Z)에 피드 50건(= 파싱 상한)이 전부 신규였다. Disquiet와 같은 넘침 신호다. 실제로 잃었는지는 확인하지 않았다(사실: 50/50 신규 2회 / 추정: 그 두 실행에서 일부 유실).
  - **나머지 소스.** geeknews-show(최대 15건/실행, 상한 40), ilddan(23건은 seed), jocohunt(sitemap 287건), showhn(96시간 창)은 상한에 닿은 기록이 없다. 판정은 붙이지 않았다.

## 진행과 판단

### 배경과 범위

사용자 요청은 처음에 원인 파악이었다. 진단을 보고한 뒤 "(a) SYDE 수정, (b) Disquiet 범위·넘침 경보·되찾기 결정" 두 가지를 모두 진행하라고 했다. 수집 파이프라인을 고치는 작업이라 [CLAUDE.md](../../CLAUDE.md) 불변식을 지켰다. `run.ts`는 non-zero로 끝내지 않는다. 워크플로 순서(collect → commit/push → deploy → report)도 그대로 두고 report 스텝만 고쳤다. 신규 판정은 seen 인덱스와 `collectedAt` 기준이다.

### 중요한 시도와 결정

- 2026-10-12 — **실패 원인 (확정).**
  - #165~#171은 수집·커밋·배포가 매번 성공했고, report 스텝만 `sources failing 2+ consecutive runs: syde`로 빨간불을 냈다(SPEC 4.2 설계대로).
  - SYDE는 10/7 07:41Z에 마지막으로 성공했다. 1·2회째 실패(#163 10/7 23:47Z, #164 10/8 07:57Z)는 조용했고, 40시간이 지난 #165(10/8 23:55Z)부터 빨간불이었다.
  - 오류는 `parse: container.count missing or non-positive`이고 로컬 `--dry-run`으로 재현했다.
  - 실제 페이지를 받아 보니 `initialShowcases`가 `{showcases, count, mentionedProfiles, currentPage}`에서 `{showcases, mentionedProfiles, nextCursor}`로 바뀌어 있었다. 목록 20건과 행 필드는 그대로였다.
  - 대체 파서는 `initialShowcases` 키가 없을 때만 동작해서 이번에는 쓰이지 않았다.
- 2026-10-12 — **SYDE 수정: healthCheck 7번 삭제** (`2496747`, [src/collectors/syde.ts](../../src/collectors/syde.ts)).
  - `nextCursor` 검사로 바꾸는 대신 지웠다. 데이터로 쓰지 않는 필드를 단언하는 것 자체가 이번 고장의 원인이고, 잘못된 객체 검출은 6·8·9·10번이 행 단위로 이미 한다.
  - 계약 먼저 원칙대로 spec 3을 고친 뒤 코드를 고쳤다. `--dry-run` 결과는 `parsed=20 would-add=7`이다.
  - 밀린 7건(10/7~10/10 게시)은 그날 20건 창 안에 남아 있었다. 창이 bumped_at 기준 약 4일이라 평일 이틀 안에 내보내야 했고, 사용자 승인으로 바로 커밋·푸시했다.
- 2026-10-12 — **Disquiet 창 넘침 발견** (실패와 별개, 경보 없음).
  - 로그의 `disquiet parsed=40 new=40`(가져온 목록 전체가 신규)를 보고 확인했다.
  - 공개 엔드포인트 1~53페이지를 전량 읽었다(읽기만). id 7484 이상 승인 1,048건 중 seen에 441건, **빠진 것 607건**이다.
  - 8/10부터 모든 주간 배치가 정확히 40건에서 잘렸다(배치 60~173건).
  - `run.ts`의 `disquiet: 40 new items (> 30) — check dedupe/seed state` 경고가 매주 떴다. 성공한 실행의 `::warning::`이라 이메일이 없었고, 문구도 원인을 seen 쪽으로 짚었다.
- 2026-10-12 — **스캔 규칙 설계** ([src/collectors/disquiet.ts](../../src/collectors/disquiet.ts) `scanPages`).
  - 처음 안은 "새 항목 없는 페이지가 연속 2번이면 멈춤"이었다. 실측해 보니 두 가지 이유로 안 된다.
    - 매주 앞 40건만 저장돼 1~2페이지는 이미 본 것이라, 그 아래 밀린 분량에 영영 닿지 못한다.
    - 늦은 승인이 지난 배치 사이로 1,269 id(48페이지)까지 퍼져서, 다음 승인일에 묵은 미수집 구간을 섞어 읽게 된다.
  - 최종안:
    - 1~2페이지에 새 항목이 없으면 거기서 멈춘다(평소 요청 2회).
    - 있으면(승인일) 최상단에서 id 1,500 아래까지 훑는다(약 50페이지, 주 1회).
    - 바닥은 `FLOOR_ID` 7484(첫 수집분)이고, 상한은 80페이지다.
    - 페이지마다 내림차순과 아래로 진행하는지 검사한다(범위 밖 페이지는 무작위 순서를 준다).
  - 1페이지 뒤 실패는 `DeepPageError`로 실행 전체를 실패시킨다. 1페이지만 읽는 폴백으로 넘기면 일부만 저장되고, 저장된 1~2페이지가 다음 실행의 멈춤 규칙을 통과시켜 나머지를 영영 다시 읽지 않기 때문이다. 1페이지만 읽는 폴백은 1페이지에 새 항목이 있으면 넘침으로 올린다.
- 2026-10-12 — **창 넘침은 1회성이어도 빨간불** (SPEC 4.2·4.5 일곱 번째, [.github/workflows/collect.yml](../../.github/workflows/collect.yml)).
  - 근거는 이번 사고다. 경고는 10주간 아무도 못 봤고, 같은 시기 SYDE의 빨간불은 바로 발견됐다. 실패는 다음 실행이 메우지만 넘침은 저절로 돌아오지 않는다.
  - 컬렉터가 `CollectResult.overflow`로 사유를 돌려주고, 받은 항목은 저장한다. `run.ts`가 `overflow_sources`로 내보내고, report 스텝이 사유를 모두 찍은 뒤 한 번에 끝낸다.
  - SYDE도 목록 20건이 전부 처음 보는 것이면 넘침이다(`sydeOverflow`).
- 2026-10-12 — **되찾기 범위: 전부** (사용자 결정).
  - 선택지는 바닥 7484(607건, 53페이지)와 8600(223건, 18페이지)이었다. 되찾은 항목은 그 실행 시각으로 들어가 사흘간 피드에 한 덩어리로 보인다는 점과, 아카이브 항목은 불변(CLAUDE.md 5)이라 되돌리기 어렵다는 점을 알렸다.
  - `NEW_COUNT_WARN`의 disquiet는 40→30에서 상한 ~1000→400으로 바꿨다. seen 유실 검출이라는 원래 목적만 남기고, 승인일 정상치(100~170)와 되찾기 실행에서는 울리지 않게 했다.
  - 처음 검토 의견은 이 항목을 빼자는 것이었다. 그런데 Disquiet의 넘침 판정은 상한·순서 깨짐만 보고 seen 유실 범람은 못 잡아서, 임계값을 올려 남겼다.
- 2026-10-12 — **되찾기 실행** (`node src/run.ts --only=disquiet --backfill`, runAt 04:55:33Z).
  - 결과는 `parsed=1060 new=607`, 넘침 없음, `verify.ts` 통과다. 되찾은 607건은 2026-08-10~10-12 승인분이다.
  - 바뀐 파일은 `site/data/2026-10.json`·`latest.json`·`state/seen/disquiet.json`(각 +607행)과 `manifest.json`(updatedAt, 10월 disquiet 81→688, disquiet 상태)이다.
  - 피드 영향: 되찾기 실행이 오늘 아침 실행보다 새것이라 오늘 피드 맨 위에 "13:55 수집 · 607건"이 오고, 300행 표시 상한 때문에 그 아래가 "남은 N건 보기" 뒤로 밀린다. 사흘 뒤 기본 화면(3일)에서 빠진다.
  - `latest.json`은 30일 동안 약 480KB에서 869KB로 커진다.
  - 로컬 실행이라 출력의 `alert_sources=syde`는 이전 manifest 값이다. 다음 예약 실행에서 SYDE가 성공하면 풀린다.

### 검증

- `node src/run.ts --dry-run --only=syde` — 통과. 수정 전 `[FAIL] syde (parse) container.count missing or non-positive`, 수정 후 `parsed=20 would-add=7`. 실제 네트워크, macOS, Node v24.19.0.
- `node src/run.ts --dry-run --only=disquiet,syde` — 통과. disquiet `parsed=40 would-add=0`(2페이지에서 멈춤), syde `would-add=7`, `overflow_sources=` 비어 있음. Node v24.19.0.
- `node src/run.ts --dry-run --only=disquiet --backfill` — 통과. `parsed=1060 would-add=607`, 넘침 없음, 15.8초. 실측 607건과 일치. Node v24.19.0.
- `npx tsc --noEmit` — 통과. `node --test 'test/*.test.ts'` — 89/89 통과(새 [test/window-overflow.test.ts](../../test/window-overflow.test.ts) 11개 포함). `node src/verify.ts` — `site/data OK`. 모두 Node v24.19.0.
- `node src/run.ts --only=disquiet --backfill`(실제 실행) — 통과. `parsed=1060 new=607`, `overflow_sources=` 비어 있음, 이어서 `node src/verify.ts` `site/data OK`. Node v24.19.0.
- CI `check`(SYDE 수정 `2496747` 푸시) — success.
- CI `check`(`069286c`·`a5fb6a2` 푸시) — success. 같은 푸시의 `collect`(push 이벤트, 배포만) — success. 배포된 `manifest.json`의 `updatedAt` 2026-10-12T04:55:33.924Z, disquiet `lastRawCount` 1060으로 되찾기 반영을 확인했다.
- 실제 예약 실행에서 SYDE 복귀, 승인일 깊은 스캔 — **미확인**.

### 세션 메모

- 2026-10-12 · claude-code (Opus 5.5) — SYDE 수정, Disquiet 스캔·넘침 빨간불·되찾기를 구현·검증해 세 커밋(`2496747`, `069286c`, `a5fb6a2`)을 푸시하고 배포를 확인했다. 다음 행동은 그날 오후 예약 실행 로그에서 SYDE 복귀를 확인하는 것이다.

## 남은 일

- [x] SYDE 수정 커밋·푸시 (`2496747`)
- [x] Disquiet 스캔·창 넘침 빨간불·`--backfill` 코드와 문서 커밋·푸시 (`069286c`)
- [x] 되찾기 로컬 실행: `node src/run.ts --only=disquiet --backfill` → `node src/verify.ts` 통과(607건).
- [x] 되찾은 데이터를 코드와 별도 커밋으로 푸시 (`a5fb6a2`), Pages 배포 확인.
- [ ] 다음 예약 실행에서 SYDE `[ok] … new=7` 근처, report 스텝 `ok`(빨간불 해제)를 확인한다.
- [ ] 2026-10-19(월) 아침 실행에서 Disquiet `parsed`가 수백이고 `overflow_sources`가 비어 있는지, 그 주 승인분이 전부 들어왔는지(신규가 40에서 잘리지 않았는지) 확인한다.
- [ ] 사람이 판단할 사항(CLAUDE.md 불변식 승격, Product Hunt 판정)을 정한다.

재개에 필요한 코드 상태: 브랜치 `main`. 이 작업의 커밋 `2496747`(SYDE), `069286c`(Disquiet 코드·문서), `a5fb6a2`(되찾은 데이터)는 모두 origin에 있다. 이 문서의 이 갱신만 그 뒤에 따로 커밋한다.
