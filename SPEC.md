# SPEC — idea-radar

구현 전에 이 문서를 끝까지 읽는다. 여기 적힌 결정 중 상당수는 "그렇게 하면 왜 깨지는지"를 확인하고 정한 것이라, 근거를 모른 채 단순화하면 조용히 데이터를 잃는다. 근거가 있는 항목에는 **왜**를 붙여 뒀다.

---

## 1. 저장소 구조

```
idea-radar/
├─ README.md  SPEC.md  TASKS.md  CLAUDE.md
├─ spec/sources/*.md          소스별 수집 계약 (실측 기반)
├─ src/
│  ├─ types.ts                아이템 스키마, 컬렉터 인터페이스
│  ├─ kst.ts                  KST 날짜 헬퍼 (단일 진실 공급원)
│  ├─ http.ts                 fetch 래퍼: UA, 타임아웃, 재시도
│  ├─ store.ts                샤드/manifest/seen 인덱스 읽기·쓰기
│  ├─ run.ts                  오케스트레이터
│  └─ collectors/
│     ├─ geeknews-show.ts  disquiet.ts  syde.ts  jocohunt.ts
│     └─ ilddan.ts  producthunt.ts  showhn.ts
├─ site/                      Pages로 배포되는 것 (빌드 없음)
│  ├─ index.html  app.js  style.css
│  └─ data/
│     ├─ manifest.json
│     ├─ latest.json          최근 30일, Show HN 제외
│     ├─ 2026-07.json         월 샤드, Show HN 제외
│     └─ 2026-07.showhn.json  월 샤드, Show HN 전용
├─ state/
│  └─ seen/{source}.json      중복제거 인덱스. 커밋되지만 배포되지 않음
└─ .github/workflows/collect.yml
```

`state/`를 `site/` 밖에 두는 이유: seen 인덱스는 컬렉터만 읽는다. Show HN은 연 5만 개 id가 쌓이는데 이걸 Pages로 배포할 이유가 없다.

---

## 2. 데이터 모델

### 2.1 아이템

```ts
type Item = {
  id: string            // "{source}:{nativeId}" — 영구 중복제거 키
  source: SourceKey
  title: string         // 원본. 최대 300자
  description: string   // 원본 한줄설명. 없으면 "". 최대 300자
  url: string           // 열어볼 캐노니컬 링크 (보통 소스 내 상세 페이지)
  externalUrl?: string  // 제품 자체 사이트. 목록 응답에 이미 있을 때만
  publishedAt?: string  // 소스가 준 발행일 ISO8601. 저장하되 v1 UI에선 표시 안 함
  collectedAt: string   // 실행 시작 시각 ISO8601. 한 실행의 모든 항목이 동일 값
  collectedDate: string // collectedAt의 KST 날짜 'YYYY-MM-DD'
  score?: number        // 소스가 주는 원본 점수 (Show HN 정렬용)
}
```

**정렬과 "새로 들어온 것" 판정은 `collectedAt` 기준이다. `publishedAt`은 절대 신규 판정에 쓰지 않는다.**
왜: Product Hunt 피드는 featured 순이라 몇 달 전 `published`가 섞여 들어오고, Disquiet의 `approved_at`은 배치 승인일이라 60건이 같은 날짜를 갖고, 앱스토어 `releaseDate`는 2~3주 지연된다. 발행일로 신규를 판정하면 반드시 누락된다.

**`collectedAt`은 실행 시작 시각을 한 번만 찍어 그 실행의 모든 항목에 같은 값을 넣는다.**
왜: 항목마다 `new Date()`를 부르면 값이 미세하게 달라져 "가장 최근 배치"를 근사 비교로 찾아야 한다. 같은 값을 쓰면 배치가 정확히 식별된다.

**`collectedDate`를 따로 저장한다.** 사이트가 KST 날짜로 묶을 때 매번 타임존 변환을 하지 않아도 되고, 하루에 여러 번 실행해도 같은 날짜로 묶인다.

**title/description은 수집 시점에 정규화한다**: HTML 태그 제거 → 엔티티 디코드 → 공백 정규화 → 300자 초과 시 절단(`…`). 이건 결정론적 문자열 처리이지 "가공"이 아니다. 원문은 어차피 `url`에 있다.

### 2.2 불변성

- 한 번 기록된 항목은 불변이다. 기존 id를 다시 봐도 title/description/collectedAt을 갱신하지 않는다.
- 중복 제거는 **소스 내부에서만** 한다. 같은 제품이 Disquiet와 Product Hunt에 다 올라오면 두 항목으로 남는다. 교차 중복 제거는 v1 범위 밖이다.

### 2.3 소스별 네이티브 id (확정)

| source | nativeId | 주의 |
|---|---|---|
| `geeknews-show` | topic id (숫자) | `data-topic-state-id` 속성 |
| `disquiet` | 숫자 `id` | **slug 쓰지 말 것** — 변경 가능 |
| `syde` | uuid | |
| `jocohunt` | slug | 숫자 id가 응답에 없음 |
| `ilddan` | product id (숫자) | |
| `producthunt` | Atom entry id에서 `/Post\/(\d+)$/` 캡처한 숫자만 | tag URI 전체를 쓰지 말 것 |
| `showhn` | `objectID` | |

### 2.4 파일 레이아웃

| 파일 | 내용 | 크기 | 누가 읽나 |
|---|---|---|---|
| `site/data/manifest.json` | 월 목록, 마지막 실행 정보, 소스별 상태 | ~2KB | 사이트(최초), 컬렉터 |
| `site/data/latest.json` | 최근 30일, Show HN 제외 | ~220KB | 사이트 기본 화면 |
| `site/data/YYYY-MM.json` | 월별, Show HN 제외 | ~220KB | 검색 |
| `site/data/YYYY-MM.showhn.json` | 월별 Show HN | ~1.1MB | 펼치거나 검색 토글 시에만 |
| `state/seen/{source}.json` | 네이티브 id 배열 (정렬) | 소스당 수십 KB~수백 KB | 컬렉터만 |

**왜 latest.json을 따로 두나**: 기본 화면이 월 샤드를 읽으면 매달 1일에 파일이 비어 있고, 아카이브가 커질수록 첫 화면이 느려진다. `latest.json`은 크기가 항상 일정해서 1년 뒤에도 첫 화면 로딩이 같다.

**왜 Show HN을 분리하나**: 물량이 나머지 전체의 5배다. 같은 파일에 넣으면 폰에서 매일 여는 첫 화면이 1.3MB가 된다.

`manifest.json`:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-29T19:37:12.000Z",
  "lastCollectedDate": "2026-07-30",
  "months": [
    { "key": "2026-07", "hasShowhn": true, "counts": { "disquiet": 31, "showhn": 4612 } }
  ],
  "sources": {
    "disquiet": {
      "lastSuccessAt": "2026-07-29T19:37:12.000Z",
      "lastRawCount": 40,
      "consecutiveFailures": 0,
      "lastError": null
    }
  }
}
```

`lastError`는 `{ at, kind: "http"|"parse"|"timeout", status?, message }` 구조로 남긴다. 차단(403/429)과 파싱 깨짐을 구분해야 대응이 달라진다.

---

## 3. 중복 제거

**`state/seen/{source}.json`에 네이티브 id 전량 인덱스를 유지한다.** 컬렉터 실행 시 이 파일을 읽어 Set을 만들고, 신규 항목을 기록할 때 append 한다.

왜 "현재 월 + 직전 월 샤드만 읽기"를 쓰지 않나: Disquiet는 배치 승인이라 오래된 항목이 뒤늦게 목록 상단에 나타나고, Product Hunt 피드는 featured 재노출로 몇 달 전 항목이 다시 들어오며, SYDE 목록은 `bumped_at` 정렬이라 옛 항목이 끌올된다. 2개월 창은 이 셋 모두에서 뚫린다. 인덱스 파일은 코드 3줄이고 연 수백 KB다.

인덱스가 없거나 손상되면: 해당 소스는 그 실행을 **실패로 처리**하고 종료한다. 빈 Set으로 진행하면 아카이브 전체가 중복된다.

**실행 내 중복 제거 순서**를 지킨다:

```
컬렉터 반환 → ① 실행 내 id dedupe(먼저 나온 것 채택) → ② seen Set 대비 필터 → ③ 샤드 append + seen 갱신
```

**페이지네이션은 고정 페이지 수가 아니라 종료 조건으로 돈다**: "한 페이지의 항목이 전부 이미 아는 id이면 중단, 최대 N페이지"(소스별 N은 `spec/sources/`에 명시). 고정 1~3페이지는 배치 유입이 있는 날 누락된다.

---

## 4. 실패 처리

### 4.1 순서 — 이걸 뒤집지 말 것

**`run.ts`는 어떤 경우에도 non-zero로 종료하지 않는다.** 파일 쓰기까지만 하고, 실패 요약을 `$GITHUB_OUTPUT`(`failed_sources=disquiet,syde`)과 `::warning::`으로 내보낸다. 커밋과 실패 신호는 워크플로 스텝이 담당한다.

```
collect (항상 성공 종료) → commit/push (if: always()) → report (실패 시 여기서 exit 1)
```

왜: `run.ts`가 `exit(1)`하면 job이 그 자리에서 중단되어 **커밋 스텝이 아예 실행되지 않는다.** 7개 중 1개만 실패해도 성공한 6개의 그날 수집분이 통째로 버려진다. GeekNews 피드 윈도우는 1.5일밖에 안 되므로 하루를 건너뛰면 영구 유실이다.

### 4.2 언제 job을 빨간불로 만드나

- 어떤 소스의 `consecutiveFailures >= 2` 이거나, **모든 소스가 실패**할 때만 `exit 1`.
- 1회성 실패는 `::warning::` + manifest 기록으로만 남기고 job은 성공으로 끝낸다.

왜: 소스 7개 중 하나가 가끔 실패하는 건 정상이다. 매일 빨간 X가 오면 2주 만에 알림을 무시하게 되고, 그때부터 알림은 없는 것과 같다.

### 4.3 healthCheck — 조용한 0건 막기

**기준은 dedupe 이전의 원본 파싱 행 수다.**

- `rawParsedCount === 0` → **throw** (그 소스 실패)
- `newItemCount === 0` → **정상** (오늘 새 글이 없었을 뿐)

이 둘을 섞으면 SYDE·일딴처럼 하루 1~2건인 소스가 글 없는 날마다 실패로 뜬다. 컬렉터는 `{ parsedCount, items }`를 반환하고 dedupe는 `run.ts`가 한다.

소스별 최소 기대 행 수와 구체적 단언은 `spec/sources/*.md`의 healthCheck 절에 있다.

### 4.4 쓰기 트랜잭션

푸시 충돌은 실제로 일어난다(폰으로 README 고치는 중 cron이 돌거나, 수동 실행이 겹칠 때). JSON에 `git rebase`를 걸면 배열이 깨지므로 **재시도 시 병합이 아니라 재계산**한다.

최대 3회 루프:

```
① git fetch origin main && git reset --hard origin/main
② 샤드·manifest·seen 인덱스 다시 읽기
③ 메모리에 든 수집 결과를 id 기준으로 재-dedupe·병합
④ 파일 재작성 → ⑤ commit → ⑥ push
push 실패 시 ①로
```

파일 쓰기 규약: `*.tmp`로 쓰고 즉시 다시 읽어 `JSON.parse` 검증 → rename. 커밋 직전에 `site/data/*.json` 전부 parse 검증, 하나라도 실패하면 커밋하지 않는다.

**샤드 파일 포맷은 "항목 1개 = 1줄"이고 append-only**(collectedAt 오름차순, 신규는 항상 끝에 추가). 정렬은 사이트가 표시할 때 한다. 왜: git이 저장하는 일일 델타가 추가된 줄만큼으로 줄고, diff로 그날 뭐가 들어왔는지 바로 보인다.

### 4.5 조용한 죽음 — 가장 위험한 실패 모드

이 시스템이 실제로 죽는 방식 대부분은 **Actions 실패를 만들지 않아 이메일이 오지 않는다**:

| 죽는 방식 | Actions 실패? |
|---|---|
| 60일 비활성 시 스케줄 워크플로 자동 비활성화 | 아니오 (실행 자체가 안 됨) |
| GitHub 부하로 cron 드롭 | 아니오 |
| Pages 배포 실패 | 아니오 (브랜치 배포 방식일 때) |
| 커밋 스텝이 조건 때문에 스킵 | 아니오 |

그래서 **1차 감지기는 사이트 상단의 전역 신선도 배너**다. `manifest.updatedAt`이 현재 시각 기준 26시간 넘게 지났으면 항목 목록보다 위에 빨간 배너를 렌더한다: `수집이 N일째 멈춤 (마지막 성공 2026-07-29 04:37 KST)`. 이 하나가 위 네 가지를 전부 잡는다.

보조로 월 1회 keepalive 워크플로(README 타임스탬프 갱신 커밋)를 둔다. GITHUB_TOKEN 봇 커밋이 60일 규칙의 "활동"으로 인정되는지 GitHub이 공식 확인해 준 적이 없기 때문이다.

---

## 5. GitHub Actions

```yaml
on:
  schedule:
    - cron: '37 19 * * *'   # 04:37 KST
  workflow_dispatch:
```

- **비정각 분(37)을 쓴다.** 정각은 전 세계 cron이 몰려 지연이 가장 크다.
- 04:37 KST는 아침에 보기 1시간 반 전이다. 30분 밀려도 6시엔 데이터가 있다.
- `permissions: contents: write, pages: write, id-token: write`
- `concurrency: { group: collect, cancel-in-progress: false }`
- `timeout-minutes: 10`
- `actions/setup-node`에 `node-version: 24`. 액션은 major 태그 고정.

**Pages 배포는 Actions 방식으로 한다.** 같은 워크플로 끝에 `actions/upload-pages-artifact`(path: `site`) + `actions/deploy-pages`를 붙이고, 저장소 설정의 Pages Source를 "GitHub Actions"로 바꾼다.

왜 브랜치 배포(`/docs` 폴더)를 안 쓰나: GITHUB_TOKEN으로 푸시한 커밋이 Pages 빌드를 트리거하지 않는 것으로 알려져 있다. 그러면 데이터는 매일 커밋되는데 사이트만 며칠째 옛날 것을 보여주고, 어디에도 실패 신호가 안 뜬다. 배포를 job 안에 넣으면 배포 실패가 실패 경로에 올라온다.

빈 커밋 방지: `git add -A && git diff --cached --quiet && echo 'no changes' && exit 0`.

---

## 6. 사이트

빌드 없음. `index.html` + `app.js` + `style.css`. 폰 우선.

### 6.1 기본 화면 — "지난 방문 이후"

**마지막 실행분이 아니라 "마지막으로 본 이후 들어온 전부"를 보여준다.**

- `localStorage.lastSeenAt`(ISO)을 저장하고, `collectedAt > lastSeenAt`인 항목을 `collectedDate` 단위로 묶어 최신일부터 표시.
- 헤더: `3일 만에 방문 · 새 항목 87건`
- 첫 방문이거나 스토리지가 없으면 최근 1일치.
- `lastSeenAt` 갱신은 페이지를 닫을 때가 아니라 **사용자가 명시적으로 "여기까지 봤음"을 누를 때** 또는 렌더 후 일정 시간 뒤에 한다. 열자마자 갱신하면 실수로 닫았을 때 그날 것을 영영 못 본다.

왜: "빠짐없게"가 이 도구의 존재 이유다. 하루 걸러 열면 어제 것이 사라지는 화면은 원래 하던 일보다 나쁘다.

### 6.2 배치

**소스별 그룹이 아니라 `collectedAt` 역순 평면 리스트.** 각 행에 소스를 작은 인라인 뱃지로 붙인다.

```
[GeekNews]  Show GN: DevClip – 클립보드 매니저를 24일간…            ↗
            복사한 것들이 하나씩 쌓이고 나중에 골라 쓰는 macOS…
```

행 전체가 `url` 탭 영역, 우측 작은 `↗`가 `externalUrl`. 링크는 `target="_blank" rel="noopener"`로 열어 목록 컨텍스트를 유지한다.

왜 소스 그룹이 아닌가: 하루 25~30건이면 그룹핑이 오히려 스캔을 방해한다. 소스별로 나뉘면 "오늘 전체를 다 봤나"를 알기 어렵다. 소스별 보기는 상단 토글로 남기되 기본값이 아니다.

Show HN은 리스트 **최하단 단일 접힘 블록**. 펼치면 `score` 내림차순으로 상위 15건 + "전체 152건" 더보기. Show HN 파일은 펼칠 때만 fetch 한다.

### 6.3 검색

- 대상: 제목 + 한줄설명, 대소문자 무시 부분일치.
- 기본 범위: **최근 12개월, Show HN 제외 샤드.** "전체 기간"과 "Show HN 포함"은 명시적 토글.
- 월 샤드를 최신순으로 하나씩 `fetch → parse → 필터 → 매칭된 것만 보관하고 파싱한 배열은 즉시 버린다`. 동시 fetch 2개 제한.
- 소스 필터 칩(전체 / 각 소스)과 기간 칩(1개월 / 3개월 / 전체)을 둔다.
- 비Show HN 누적이 5만 건을 넘으면 그때 인덱스 도입을 검토한다. 연 1만 건이므로 5년치다.

### 6.4 로딩 순서 (3초 안에 오늘 것)

1. `localStorage`에 캐시된 직전 렌더 데이터로 **동기 렌더** — 첫 페인트에 네트워크 의존 없음
2. `manifest.json` + `latest.json` fetch (캐시 회피용 `?v=` 쿼리)
3. 갱신 렌더, 신선도 배너 판정
4. Show HN은 펼칠 때만

`sessionStorage`에 `scrollY`와 펼침 상태를 저장하고 렌더 직후 복원, `history.scrollRestoration = 'manual'`.

### 6.5 빈 화면 대신

오늘 신규가 0건이면 빈 화면 대신 `오늘 04:41 기준 새 항목 없음`을 표시한다. 빈 화면은 "고장났나?"로 읽힌다.

---

## 7. 최초 실행 (bootstrap)

`node src/run.ts --seed`로 1회 실행한다. 수집분을 아카이브와 seen 인덱스에는 넣되 **`collectedAt`을 어제 이전으로 백데이트**해 "오늘 신규"에 나타나지 않게 한다.

왜: seed 없이 첫 실행을 하면 Show HN만 수백 건이 "오늘 새로운 것"으로 뜬다. 첫인상이 "감당 안 되는 도구"가 된다.

Show HN 컬렉터는 **커서 상태 파일을 만들지 않는다.** 고정 윈도우(현재 시각 − 96시간) + id dedupe로 대체한다. 커서를 파일에 두면 커밋 실패 시 커서만 앞서 나가 그 구간이 영구 유실된다. 96시간 창은 하루 이틀 실패해도 자동으로 메워진다.

---

## 8. 명시적으로 잘라낸 것

넣지 않기로 한 것들. 나중에 "이거 왜 없지" 할 때 여기를 본다.

| 잘라낸 것 | 이유 | 복귀 조건 |
|---|---|---|
| 2군 소스 7곳 (OKKY, EO플래닛, 플래텀, 벤처스퀘어, 와우테일, 지피터스, 앱스토어 RSS) | 전부 키워드 필터 튜닝이 필요하다. 그게 유지비다 | v1이 2주 살아남고 물량이 부족하다고 느껴지면 |
| 렛플 | 비공개 POST 내부 API가 유일한 경로 + 물량 대부분이 자동수집된 해외 앱 | 없음 |
| 앱스토리 | 신규 앱 카테고리가 2021년부터 사실상 중단 | 없음 |
| LLM 요약·태깅·분류 | 이전 프로젝트의 유지비 폭탄 | 없음 |
| 별표 / 메모 / 읽음 표시 | v1은 "오늘 보기 + 나중에 검색"에 집중 | 검색만으로 못 찾겠다고 느껴지면 v1.1 (localStorage + 내보내기 버튼, Safari가 스토리지를 지울 수 있음을 감안) |
| 교차 소스 중복 제거 | 같은 제품이 두 소스에 뜨는 건 오히려 신호다 | 거슬리면 v1.1에서 externalUrl 정규화 |
| 런타임 npm 의존성 | Atom도 정규식으로 뽑는다. 다른 소스는 어차피 HTML/JSON 정규식 파싱이다 | XML 파싱이 실제로 깨지면 `fast-xml-parser` 1개까지 허용 |
| `externalUrl`을 위한 추가 요청 | 목록 응답에 이미 있을 때만 채운다 | GeekNews만 예외 (아래) |

잘라낸 2군 소스 7곳의 검증된 엔드포인트·파싱법·물량은 [`spec/source-research.json`](spec/source-research.json)에 남아 있다. 나중에 켤 때 다시 조사하지 않아도 된다.

**GeekNews의 예외 두 가지**는 근거가 있어 허용한다:
1. 신규 항목당 상세 페이지 1회 추가 요청(하루 ~7회). 목록의 제목이 86자에서 잘리기 때문이다. 잘린 제목을 영구 저장하는 게 "원본 그대로" 원칙에 더 어긋난다.
2. `/show` 페이지를 쓰므로 제목 접두어 필터가 **필요 없다**. `/show`는 Show 전용 섹션이다. `Show GN:` prefix 필터를 걸지 말 것 — 접두사가 바뀌면 조용히 0건이 된다.
