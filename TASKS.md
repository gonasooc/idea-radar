# TASKS — 구현 순서

> **0~7절은 끝났다.** 2026-07-29 seed 이후 하루 2회 수집이 돌고 있다. 남은 것은 **8절 kill test** 하나이고
> 그 시점(seed +2주)이 2026-08-12다. 아래 체크리스트는 무엇을 어떤 순서로 만들었는지의 기록이므로,
> 현재 동작의 정본은 여기가 아니라 [SPEC.md](SPEC.md)다 — 둘이 어긋나면 SPEC이 맞다.

각 단계는 **끝나면 눈으로 확인할 수 있는 것**으로 끝난다. 순서를 바꾸지 않는 게 좋다 — 뒤 단계가 앞 단계의 검증에 의존한다.

가장 흔한 실패는 컬렉터 7개를 먼저 다 만들고 마지막에 파이프라인을 붙이는 것이다. 그러면 어느 층이 깨졌는지 알 수 없다. **소스 1개로 끝까지 관통시킨 다음** 나머지를 복제한다.

---

## 0. 저장소 준비

- [x] GitHub에 public repo `idea-radar` 생성
- [x] 이 문서들(`README.md`, `SPEC.md`, `TASKS.md`, `CLAUDE.md`, `spec/sources/`) 커밋
- [x] `.nvmrc`에 `24`, `package.json`에 `{ "type": "module", "private": true }` — **dependencies 없음**
- [x] 저장소 Settings → Pages → Source를 **GitHub Actions**로 설정
- [x] Settings → Notifications에서 Actions 실패 알림이 켜져 있는지 확인 (실패만 받도록)

**완료 기준**: `node --version`이 v24 이상이고 repo가 clone된다.

---

## 1. 뼈대 — 타입, KST, HTTP

- [x] `src/types.ts` — `Item`, `SourceKey`, `CollectResult = { parsedCount: number; items: Item[] }`, `Collector` 인터페이스
- [x] `src/kst.ts` — `kstDate(d): 'YYYY-MM-DD'`, `kstMonthKey(d): 'YYYY-MM'`. `Intl.DateTimeFormat`에 `timeZone: 'Asia/Seoul'`
- [x] `src/http.ts` — 브라우저 UA 고정, 타임아웃(기본 15초), 1회 재시도, 요청 간 300ms 대기
- [x] `clean(s)` 헬퍼 — 태그 제거 → 엔티티 디코드(최소 `&quot; &amp; &lt; &gt; &#039; &nbsp;`) → 공백 정규화 → 300자 절단

**완료 기준**: `kstDate(new Date('2026-07-29T19:37:00Z'))`가 `'2026-07-30'`을 반환한다. 이 하나가 틀리면 샤드 키가 전부 어긋난다.

> ⚠️ 타입 스트리핑 제약: Node 24는 `.ts`를 실행하되 **지울 수 있는 문법만** 허용한다. `enum`, `namespace`, 파라미터 프로퍼티(`constructor(private x)`)를 쓰지 말고 `type`/`interface`/`as const`만 쓴다.

---

## 2. 저장 계층

- [x] `src/store.ts` — 샤드/manifest/seen 읽기·쓰기
- [x] 샤드 포맷: **항목 1개 = 1줄**, append-only, `collectedAt` 오름차순
- [x] 쓰기 규약: `*.tmp`에 쓰고 → 다시 읽어 `JSON.parse` 검증 → rename
- [x] seen 인덱스가 없거나 파싱 실패면 그 소스를 **실패 처리**(빈 Set으로 진행 금지)
- [x] `latest.json` 재생성: 월 샤드들에서 최근 30일 + Show HN 제외로 매 실행마다 다시 만든다

**완료 기준**: 가짜 아이템 3건을 넣고 `run` → 파일 생성 → 다시 `run` 했을 때 중복이 0건이다.

---

## 3. 첫 소스 관통 — Disquiet

가장 단순한 소스(인증 없는 JSON)로 파이프라인 전체를 뚫는다. `spec/sources/2-disquiet.md`를 그대로 따른다.

- [x] `src/collectors/disquiet.ts`
- [x] `src/run.ts` — 컬렉터 실행 → 실행 내 dedupe → seen 대비 필터 → 샤드 append → manifest 갱신
- [x] `--dry-run`, `--only=<source>`, `--seed` 플래그
- [x] `run.ts`는 **어떤 경우에도 non-zero 종료하지 않는다.** 실패 요약을 `$GITHUB_OUTPUT`과 `::warning::`으로

**완료 기준**: `node src/run.ts --only=disquiet` 두 번 연속 실행 시 두 번째는 신규 0건이고, `site/data/`에 유효한 JSON이 생긴다.

---

## 4. 나머지 컬렉터 6개

각각 `spec/sources/*.md`를 따른다. 하나 만들 때마다 `--only=`로 검증하고 다음으로 넘어간다.

- [x] `geeknews-show` — `/show` 1~2페이지 + 신규 항목당 상세 1회. **`Show GN:` prefix 필터 걸지 말 것**
- [x] `syde` — RSC flight 청크 이어붙여 `initialShowcases` 파싱
- [x] `jocohunt` — 홈 SSR flight payload + sitemap diff 보조
- [x] `ilddan` — `?cat=web`과 `?cat=game` 두 URL, React Query dehydrated JSON
- [x] `producthunt` — Atom entry 정규식, id는 `/Post\/(\d+)$/` 캡처분만
- [x] `showhn` — 96시간 고정 창 + id dedupe. **커서 파일 만들지 말 것**

각 컬렉터는 파싱 직후 `parsedCount === 0`이면 throw 한다.

**완료 기준**: `node src/run.ts --dry-run`이 7개 소스 전부에서 0건 아닌 `parsedCount`를 찍는다.

---

## 5. Actions

- [x] `.github/workflows/collect.yml`
- [x] 스텝 순서를 **반드시** 이렇게: `collect`(항상 성공 종료) → `commit/push`(`if: always()`) → `deploy-pages` → `report failures`(여기서 `exit 1`)
- [x] 푸시 재시도: 최대 3회, 실패 시 `fetch + reset --hard` 후 재계산 (SPEC 4.4)
- [x] 빈 커밋 가드
- [x] `cron: '37 19 * * *'`, `workflow_dispatch`, `concurrency: collect`, `timeout-minutes: 10` — 이후 점심 수집 `43 1 * * *`이 추가됐다 (SPEC 5)
- [x] `permissions: contents: write, pages: write, id-token: write`

**완료 기준 (day-1 게이트)**: `workflow_dispatch`로 **실제 러너에서** 1회 성공시킨다. 로컬에서 되는 것과 러너에서 되는 것은 다르다 — GitHub IP가 차단당하는 소스가 있을 수 있다. 러너에서 실패하는 소스는 v1 목록에서 뺀다.

---

## 6. 사이트

- [x] `site/index.html` — 폰 우선, 빌드 없음
- [x] 기간 칩(1/3/7/30일, 기본 3일) 기반 "최근 N일" 화면 — 방문 기록·읽음 상태 없음
- [x] `collectedAt` 역순 평면 리스트 + 소스 뱃지
- [x] **전역 신선도 배너** — `manifest.updatedAt`이 26시간 초과면 빨간 배너. 이게 1순위 고장 감지기다
- [x] Show HN — 최하단 접힘 블록으로 만들었다가 **v3에서 소스 칩으로 합쳤다**. 칩을 고를 때만 fetch (SPEC 6.2)
- [x] 검색: 월 샤드 최신순 순회, 소스 칩 + 기간 칩
- [x] `sessionStorage` 스크롤 복원, `history.scrollRestoration = 'manual'`
- [x] 신규 0건일 때 빈 화면 대신 안내 문구

**완료 기준**: 폰에서 Pages URL을 열었을 때 3초 안에 오늘 항목이 보이고, 홈 화면에 추가했을 때 아이콘이 제대로 뜬다.

---

## 7. 시딩과 관찰

- [x] `node src/run.ts --seed` 1회 실행 후 커밋
- [x] 3일간 매일 아침 실제로 열어보고, 원래 사이트도 같이 열어 **놓친 항목이 있는지** 대조
- [x] 소스별 실제 물량을 `spec/sources/*.md`의 예상 범위와 비교해 어긋나면 문서 갱신

**완료 기준**: 3일 연속 자동 수집이 돌고, 대조에서 누락이 없다.

---

## 8. 2주 뒤 kill test — **남은 단계**

달력에 넣어둔다. seed가 2026-07-29였으므로 **2026-08-12**다.

- 여전히 Disquiet / Product Hunt / GeekNews Show / SYDE / 조코헌트 / 일딴을 직접 열고 있는가?
- 그렇다면 **기능을 추가하지 말고** 왜 안 열게 되는지부터 본다. 느려서인지, 놓칠까 봐 불안해서인지, 화면이 안 읽혀서인지.
- 잘 쓰고 있다면 그때 2군 소스 추가나 별표 기능을 검토한다.
