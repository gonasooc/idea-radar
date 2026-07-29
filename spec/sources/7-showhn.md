# Show HN (`showhn`)

> 이 문서는 2026-07-29에 **실제 HTTP 응답을 받아** 작성된 수집 계약이다.
> 추측이 아니라 실측이며, `sampleItem`은 그날 받은 진짜 데이터다.
> 사이트가 바뀌면 이 문서를 먼저 고치고 코드를 고친다.

## 일일 물량

실측 약 139~156건/일. 36시간 창 = 230건(=155.7/일), 168시간(7일) 창 = 972건(=139.2/일). 2026-07-29 03:41 UTC 기준 실제 호출 결과. 다른 소스 전체 합의 약 5배이므로 UI에서 소스별 필터/접기를 고려할 것.

## 요청

■ 메인 요청 (1회면 충분, 페이지네이션 불필요)

메서드: GET
호스트: hn.algolia.com (인증 없음, API 키 없음, 쿠키 없음)

  const WINDOW_HOURS = 96;                                  // 권고값. 아래 "증분 파라미터" 결론 참조
  const since = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600;
  const url = `https://hn.algolia.com/api/v1/search_by_date`
            + `?tags=show_hn`
            + `&hitsPerPage=1000`
            + `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`;

실제 확인된 URL 형태 (그대로 복붙 가능):
  https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=1000&numericFilters=created_at_i%3E1784950851

필수 헤더:
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36
  Accept: application/json
  (Authorization / X-Algolia-* 헤더 일절 불필요. 붙이면 오히려 400 위험)

타임아웃 20초, 실패 시 지수백오프로 2회 재시도(2s, 6s).

■ 페이지 수
- hitsPerPage=1000이 실제로 동작함(검증: 7일 창 972건을 nbPages=1, 단일 응답 1.62MB로 반환).
- 96시간 창 예상 ~560건이므로 항상 1페이지. 응답 크기 ~0.9MB, 지연 ~1.0초.
- 그래도 방어 코드 필수: `if (body.nbHits > body.hits.length)` 이면 `&page=1`, `&page=2` … `page = body.nbPages-1`까지 추가 GET 후 hits를 concat.
  (page 파라미터 동작 검증됨: hitsPerPage=500&page=1이 nbPages=2, 472건을 정확히 반환했고 1000건 단일 응답과 id가 100% 일치.)

■ 레이트리밋
시간당 10,000회. 하루 1회 실행이므로 사실상 무제한. 백필 시에도 창을 넓히면 되지 회차를 늘릴 필요 없음.

■ 증분 파라미터 저장 위치 — 결론: 별도 상태 파일 만들지 말 것
고정 윈도우(현재시각 - 96h) + id dedupe로 완전히 대체 가능하며, 그쪽이 더 안전하다.
1. GitHub Actions의 schedule은 수 분~수 시간 지연되고 러너 혼잡 시 아예 스킵된다. "마지막 수집 시각"을 파일로 들고 다니면 커밋 실패/충돌 한 번에 그 구간이 영구 유실된다.
2. 고정 윈도우는 자가치유된다. 하루치 실행이 통째로 날아가도 다음 날 실행이 96시간을 다시 훑어 자동 백필한다(3회 연속 실패까지 커버).
3. 96h × 156건/일 ≈ 600건 < hitsPerPage 1000. 여유 40%. 창을 넓혀도 요청 수는 그대로 1회이므로 비용이 0이다.
4. id가 `showhn:{objectID}`로 영구 고유하므로 중복은 병합 단계에서 원천 차단된다. 상태 파일이 주는 이득이 "이미 본 것 재파싱 안 함" 뿐인데, 그 비용이 CPU 수십 밀리초라 의미 없다.
※ 단, 병합 시 **기존 id의 collectedAt은 절대 덮어쓰지 말 것**. 이걸 어기면 96시간치 아이템이 매일 "오늘 새로운 것"으로 재등장한다. 이것이 상태 파일 없는 설계의 유일한 필수 규약이다.

## 파싱 절차

1. 응답 status가 200이 아니거나 `content-type`에 `application/json`이 없으면 즉시 실패 처리(부분 저장 금지).

2. `JSON.parse(body)` → 최상위 객체. 실측 키: `exhaustive, exhaustiveNbHits, exhaustiveTypo, hits, hitsPerPage, nbHits, nbPages, page, params, processingTimeMS, processingTimingsMS, query, serverTimeMS`.

3. 아이템 배열 = JSON 경로 `$.hits` (배열). `Array.isArray(body.hits)`가 false면 실패.

4. 절단 방어: `body.nbHits > body.hits.length` 이면 `page=1..body.nbPages-1`을 추가 GET 하여 `hits`를 이어붙인다.

5. 각 hit에서 뽑는 원시 필드 (JSON 경로 기준):
   - `hit.objectID`   : string, 항상 존재, `/^[0-9]+$/` (972건 전수 검증). `String(hit.story_id) === hit.objectID` 항상 성립.
   - `hit.title`      : string, 항상 존재.
   - `hit.url`        : string. **텍스트 전용 글은 키 자체가 없음(undefined)이며 null이 아니다.** 972건 중 32건 키 부재, null은 0건.
   - `hit.story_text` : string(HTML). **역시 키 자체가 없음.** 972건 중 553건 키 부재, null 0건.
   - `hit.created_at` : ISO8601 (예 `"2026-07-29T03:19:19Z"`). 항상 존재, 항상 파싱 가능, `created_at_i`와 1초 이내 일치(전수 검증).
   - `hit._highlightResult`, `_tags`, `points`, `num_comments`, `author`, `updated_at`, `story_id` : **전부 무시**. 특히 `_highlightResult`는 같은 내용을 중복으로 담고 있어 파싱 대상으로 삼지 말 것.

6. HTML 엔티티 디코더 (순서가 중요 — 숫자 참조 먼저, `&amp;`를 반드시 마지막에):

   function decodeEntities(s) {
     return s
       .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
       .replace(/&#(\d+);/g,           (_, c) => String.fromCodePoint(parseInt(c, 10)))
       .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&');
   }
   (`&amp;`를 먼저 풀면 `&amp;lt;` 같은 원문 리터럴이 `<`로 잘못 복호화된다.)

7. description 추출 — `hit.story_text`에서 첫 문단(들):

   function toDescription(storyText) {
     if (!storyText) return '';
     const paras = storyText.split(/<p>/)                       // HN은 문단 구분에 여는 <p>만 쓴다. </p> 없음
       .map(p => decodeEntities(p.replace(/<[^>]*>/g, ' '))     // <a href>, <i>, <pre><code> 제거
                   .replace(/\s+/g, ' ').trim())
       .filter(p => p && !/^https?:\/\/\S+$/.test(p));          // 첫 문단이 링크만인 경우 스킵(externalUrl과 중복)
     let out = '';
     for (const p of paras) { out = out ? out + ' ' + p : p; if (out.length >= 60) break; }
     if (out.length > 400) out = out.slice(0, 399).replace(/\s+\S*$/, '') + '…';
     return out;
   }

   검증 결과(230건 창): 비어있지 않은 description 101건, 길이 p50=198, max=399, 60자 미만 잔여 0건.
   `>= 60` 루프가 `"Hey HN,"`(6자) 같은 인사말 첫 문단을 다음 문단과 자동으로 합쳐준다.

8. externalUrl 추출:

   const m = hit.story_text && hit.story_text.match(/<a href="([^"]+)"/);
   const externalUrl = hit.url || (m ? decodeEntities(m[1]) : undefined);

   href 속성값은 `https:&#x2F;&#x2F;seaticket.ai&#x2F;` 처럼 슬래시가 인코딩되어 있으므로 **반드시 decodeEntities를 통과시킬 것.**
   검증: 230건 중 228건에서 externalUrl 확보. 확보 실패 2건은 url도 story_text 내 링크도 없는 순수 텍스트 글(정상).

9. 최종 매핑(다음 fieldMapping 참조) 후, `collectedAt`은 **배치 전체에 동일한 단일 타임스탬프**를 쓴다(`const now = new Date().toISOString()`를 루프 밖에서 한 번). 아이템마다 호출하면 같은 배치가 밀리초 단위로 흩어져 정렬이 불안정해진다.

10. 병합: 기존 아카이브 JSON을 id → item 맵으로 로드. 신규 id만 `collectedAt = now`로 삽입. **이미 존재하는 id는 어떤 필드도 건드리지 않고 통째로 스킵**(title/points가 나중에 바뀌어도 무시 — 아카이브는 최초 관측 스냅샷).

## 필드 매핑

공통 스키마 ← Algolia hit

| 공통 필드 | 소스 | 규칙 |
|---|---|---|
| `id` | `hit.objectID` | `` `showhn:${hit.objectID}` `` — objectID는 HN 아이템 번호(불변, 재사용 없음)이므로 영구 dedupe 키로 안전. 972건 전수 유니크 확인. |
| `source` | — | 리터럴 `"showhn"` |
| `title` | `hit.title` | `decodeEntities(hit.title).trim()`. `"Show HN: "` 접두사는 **제거하지 않음**(원본 유지 원칙, 그리고 접두사가 `"Show NH:"`처럼 오타난 케이스가 실재해 안전한 제거 규칙을 만들 수 없음). |
| `description` | `hit.story_text` | parseSteps 7의 `toDescription()`. 키 부재 시 `""` (230건 중 129건이 `""`, 즉 56%가 빈 설명 — 정상이며 링크형 Show HN에는 본문이 아예 없다). |
| `url` | `hit.objectID` | 항상 `` `https://news.ycombinator.com/item?id=${hit.objectID}` ``. **`hit.url`을 쓰지 않는다.** 스키마상 url은 "소스 내 상세 페이지"이고, 이렇게 하면 (a) 키 부재 폴백 분기가 사라져 url이 100% 채워지며 (b) 폰에서 열었을 때 댓글까지 볼 수 있고 (c) 제품 사이트가 죽어도 아카이브 링크가 살아있다. |
| `externalUrl` | `hit.url` → 폴백 `story_text` 첫 `<a href>` | parseSteps 8. 값이 없으면 **키 자체를 생략**(`undefined` 할당 후 `JSON.stringify`로 자동 제거하거나 조건부 대입). `""`를 넣지 말 것. 확보율 228/230. |
| `publishedAt` | `hit.created_at` | `new Date(hit.created_at).toISOString()`. 소스 값은 이미 `"2026-07-29T03:19:19Z"` 형식이지만 밀리초 표기를 통일하기 위해 재직렬화(`...T03:19:19.000Z`). `hit.created_at_i * 1000`으로 만들어도 결과 동일(1초 이내 일치 전수 확인). |
| `collectedAt` | — | 배치 시작 시각 `new Date().toISOString()`. 루프 밖에서 1회 생성. **재수집된 기존 id에는 재할당 금지.** |

빠진 필드 채우는 법:
- `description` 없음 → `""` (스키마 규정대로. LLM 생성 금지)
- `externalUrl` 없음 → 키 생략
- `publishedAt`은 사실상 항상 존재하지만, 방어적으로 `Date.parse`가 NaN이면 키 생략
- `title`이 빈 문자열인 아이템은 저장하지 말고 드랍(972건 중 0건이지만 방어)

## 실제 샘플

2026-07-29T03:41:01Z에 실제 호출한 응답의 최신 hit(objectID 49093051)을 변환한 실제 값:

{
  "id": "showhn:49093051",
  "source": "showhn",
  "title": "Show HN: MetrIQ – An AI fitness coach who supports you",
  "description": "metrIQ started as a spreadsheet for my own training. The numbers were fine, but a spreadsheet never tells you anything — it just holds what you typed.",
  "url": "https://news.ycombinator.com/item?id=49093051",
  "externalUrl": "https://metriq.fitness",
  "publishedAt": "2026-07-29T03:19:19.000Z",
  "collectedAt": "2026-07-29T03:41:01.000Z"
}

원본 hit(발췌): {"objectID":"49093051","story_id":49093051,"author":"zinas","title":"Show HN: MetrIQ – An AI fitness coach who supports you","url":"https://metriq.fitness","created_at":"2026-07-29T03:19:19Z","created_at_i":1785295159,"points":1,"num_comments":0,"story_text":"metrIQ started as a spreadsheet for my own training. The numbers were fine, but a spreadsheet never tells you anything — it just holds what you typed.<p>So I switched to asking ChatGPT. ...","_tags":["story","author_zinas","story_49093051","show_hn"]}

■ 두 번째 실제 샘플 — `url` 키가 아예 없는 텍스트 전용 글 (폴백 경로 검증용, objectID 49092665):

{
  "id": "showhn:49092665",
  "source": "showhn",
  "title": "Show HN: SeaTicket – Duplicate Bug Finder for GitHub",
  "description": "I built SeaTicket to correlate duplicate bug reports across GitHub, Discord, forums, and email. Instead of relying on matching keywords, it identifies reports that likely describe the same underlying issue and catch the duplication.",
  "url": "https://news.ycombinator.com/item?id=49092665",
  "externalUrl": "https://seaticket.ai/",
  "publishedAt": "2026-07-29T02:11:49.000Z",
  "collectedAt": "2026-07-29T03:41:01.000Z"
}

이 건의 원본 `story_text`는 `"<a href=\"https:&#x2F;&#x2F;seaticket.ai&#x2F;\" rel=\"nofollow\">https:&#x2F;&#x2F;seaticket.ai&#x2F;</a><p>I built SeaTicket to correlate..."` 였다.
→ externalUrl은 href에서 뽑아 `&#x2F;`를 디코딩했고, description은 링크만인 첫 문단을 스킵해 두 번째 문단을 채택했다.

## healthCheck

아래 단언을 순서대로 실행. 하나라도 깨지면 **커밋하지 말고 워크플로를 실패시킨다**(부분 데이터 커밋 금지). 96시간 창 기준.

A. 전송 계층
  1. `res.status === 200`
  2. `res.headers['content-type']` 에 `'application/json'` 포함
  3. `JSON.parse`가 예외 없이 성공

B. 응답 구조
  4. `Array.isArray(body.hits) === true`
  5. `typeof body.nbHits === 'number'`
  6. `body.nbHits <= body.hits.length` — 거짓이면 페이지네이션 미수행 = 조용한 절단. 페이지 루프를 돌고 재검사.

C. 볼륨 (실측 139~156건/일 → 96h 기대 556~624건)
  7. `body.hits.length >= 200` — 기대치의 36%. 이하이면 소스 이상으로 간주하고 실패.
     (참고 실측: 36h→230건, 168h→972건. 96h에서 200건 미만은 정상 변동 범위를 크게 벗어난다.)
  8. `body.hits.length <= 5000` — 상한. 넘으면 tags 필터가 무력화된 것.

D. 신선도 — "인덱스가 멈췄는지" 판별. 이게 가장 중요한 단언이다.
  9. `const newest = Math.max(...body.hits.map(h => h.created_at_i));`
     `(Date.now()/1000 - newest) < 12 * 3600`
     Show HN은 시간당 5~7건 올라오므로 최신 글이 12시간보다 오래됐다면 Algolia 인덱싱이 지연/중단된 것. (실측: 호출 시각과 최신 글의 간격이 22분이었다.)
  10. `const oldest = Math.min(...);  (newest - oldest) >= 60 * 3600`
      96시간 창인데 실제 커버 구간이 60시간 미만이면 numericFilters가 먹지 않았거나 결과가 잘렸다.

E. 필드 무결성 (전 hit 대상, 972건 전수 통과 확인됨)
  11. `body.hits.every(h => /^[0-9]+$/.test(h.objectID))`
  12. `body.hits.every(h => typeof h.title === 'string' && h.title.trim().length > 0)`
  13. `body.hits.every(h => !isNaN(Date.parse(h.created_at)))`
  14. `new Set(body.hits.map(h => h.objectID)).size === body.hits.length` (응답 내 중복 0)
  15. 태그 정합성: `body.hits.every(h => h._tags.includes('show_hn') && h._tags.includes('story'))`
      — `comment` 태그가 섞이면 `tags=show_hn` 필터가 깨진 것. (실측 230건 태그 분포: story 230, show_hn 230, front_page 3 — 댓글 0건.)
  16. 제목 규약: `body.hits.filter(h => /^show\s*[hn]{2}\b/i.test(h.title)).length / body.hits.length >= 0.95`
      실측 972건 중 위반 1건(오타 `"Show NH:"`)으로 99.9%. 95% 미만이면 잘못된 인덱스를 읽고 있는 것.

F. 변환 후 (transform 결과 items 대상)
  17. `items.every(i => /^showhn:[0-9]+$/.test(i.id))`
  18. `items.every(i => /^https:\/\/news\.ycombinator\.com\/item\?id=[0-9]+$/.test(i.url))` — 100% 통과해야 함(폴백 분기가 없으므로 예외가 있으면 버그)
  19. `items.every(i => typeof i.description === 'string')` (빈 문자열 허용)
  20. `items.every(i => i.description.length <= 401)` — 절단 로직 동작 확인
  21. `items.filter(i => i.externalUrl).length / items.length >= 0.90` — 실측 228/230 = 99.1%. 90% 미만이면 href 정규식이나 엔티티 디코더가 깨진 것.
  22. `items.every(i => !i.externalUrl || /^https?:\/\//.test(i.externalUrl))` — `&#x2F;` 디코딩 실패 시 여기서 잡힌다.
  23. 빈 description 비율 `items.filter(i => !i.description).length / items.length` 가 0.40~0.75 구간 — 실측 0.56. 이 구간을 벗어나면(특히 0.9 초과) story_text 파싱이 죽은 것.

G. 병합 후 (경보만, 실패 처리는 하지 않음)
  24. `신규 id 수`가 0이면 경보. 96시간 창에서 신규 0은 병합 로직 버그(모든 id가 기존으로 판정)를 뜻한다.
  25. `신규 id 수 > 400`이면 경보. 정상 일일 유입은 139~156. 400 초과는 collectedAt 보존 규약이 깨져 재유입되고 있다는 신호.

## 폴백

2단 폴백. 둘 다 인증 불필요이며 1차와 **제공자가 다르다**(Algolia ↔ Google Firebase)는 게 핵심이다.

■ 폴백 1 — 같은 Algolia, numericFilters 제거 (경미한 장애: 400/필터 파싱 오류일 때)
  GET https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=500
  시간 필터 없이 최신순 500건을 그냥 받는다. 500건 ≈ 3.4일치이므로 96시간 창을 사실상 그대로 커버한다.
  파싱/매핑은 1차와 100% 동일. id dedupe가 초과분을 흡수하므로 부작용 없음.
  → 이건 사실상 무료 보험이므로, 1차 URL이 non-200을 내면 조건 없이 한 번 시도할 것.

■ 폴백 2 — 공식 HN Firebase API (Algolia 자체가 죽었을 때. 실호출 검증 완료)
  a) GET https://hacker-news.firebaseio.com/v0/showstories.json
     → 정수 id 배열. 실측 197개 반환 (1,774바이트). 현재 Show HN 목록 전체.
  b) 각 id에 대해 GET https://hacker-news.firebaseio.com/v0/item/{id}.json
     실측 응답 예(id 49090607): {"by":"twalichiewicz","descendants":55,"id":49090607,"kids":[...],"score":175,
     "text":"HN is great for the links people share...<p>I figured there was probably a simpler way...",
     "title":"...","type":"story","time":<unix>,"url":"..."}

  필드명이 다르므로 어댑터 필요:
     objectID   → String(item.id)
     title      → item.title
     url        → item.url        (텍스트 글은 키 부재, Algolia와 동일 양상)
     story_text → item.text       (**엔티티 인코딩 방식이 Algolia와 완전히 동일** — `&#x27;`, `<p>` 확인. decodeEntities/toDescription 재사용 가능)
     created_at → new Date(item.time * 1000).toISOString()
  → 어댑터로 hit 모양으로 정규화한 뒤 기존 transform을 그대로 태우면 된다.

  비용/제약:
   - 요청 198회. 레이트리밋 없음(Firebase 공개 읽기)이지만 동시성 8 정도로 제한하고 실패 건은 개별 스킵.
   - 최신순 정렬이 아니라 **HN "Show" 페이지 랭킹 순서**다. `time`으로 직접 desc 정렬할 것.
   - 커버리지가 약 197건(≈1.3일)이라 96시간 백필은 불가능. 이 경로로 수집한 날은 그날치만 확보된다.
   - `type !== "story"`인 항목이 섞이면 드랍.

■ 폴백 3 — 없음
  news.ycombinator.com/show HTML 스크래핑은 권하지 않는다. 30건뿐이고 타임스탬프가 "3 hours ago" 상대표기라 collectedAt/publishedAt 신뢰도가 떨어진다. 폴백 2가 같은 데이터를 더 정확히 준다.

■ 전부 실패했을 때
  이번 회차 showhn 수집을 **스킵하고 다른 소스는 정상 커밋**한다. 96시간 고정 윈도우 덕분에 다음 회차가 자동으로 백필하므로, 실패를 워크플로 전체 실패로 승격시키지 말 것. 단 로그에 `showhn: SKIPPED` 를 남겨 25번 경보와 구분되게 한다.

## 함정

1. **`url`과 `story_text`는 null이 아니라 "키 자체가 없다"**. 과제 설명에는 null로 적혀 있으나 실제 응답은 키 부재다(972건 중 url 부재 32건 / null 0건, story_text 부재 553건 / null 0건). `hit.url === null` 체크는 절대 걸리지 않는다. 반드시 `!hit.url` 또는 `'url' in hit` 로 판별할 것. 이거 하나로 조용히 폴백이 안 도는 버그가 난다.

2. **HTML 엔티티 디코딩 순서**. `&amp;`를 마지막에 풀어야 한다. 먼저 풀면 원문 리터럴 `&amp;lt;` 가 `<`로 잘못 복호화된다. 그리고 HN은 **슬래시를 `&#x2F;`로, 아포스트로피를 `&#x27;`로** 인코딩한다 — `https:&#x2F;&#x2F;example.com` 형태가 story_text와 href 양쪽에 나온다. externalUrl을 href에서 뽑을 때 디코딩을 빠뜨리면 `https:&#x2F;&#x2F;...` 라는 열리지 않는 링크가 저장된다. 230건 중 84건이 엔티티를 포함하고 있었다.

3. **`<p>`는 여는 태그만 있고 `</p>`가 없다.** HN 렌더링 관례다. `split('</p>')`는 항상 1개 원소를 반환해 문단 분리가 통째로 실패한다. 반드시 `split(/<p>/)`.

4. **story_text에는 `<a href ... rel="nofollow">`, `<i>`, `<pre><code>`가 섞인다** (230건 중 링크 40건, i/pre/code 5건). 태그 제거 정규식 `/<[^>]*>/g`를 엔티티 디코딩 **전에** 적용해야 한다. 순서를 바꾸면 `&lt;script&gt;` 가 실제 태그로 변한 뒤 제거되어 원문이 손상된다.

5. **첫 문단이 링크 하나뿐인 글이 있다** (예 objectID 49092665의 첫 문단 = `https://seaticket.ai/`). 그대로 쓰면 description과 externalUrl이 동일해져 카드가 무의미해진다. 링크 전용 문단은 스킵할 것. 반대로 `"Hey HN,"`(6자) 같은 인사말 첫 문단도 있으므로 60자 누적 루프가 필요하다.

6. **description이 비는 게 정상이다 — 56%**. 링크형 Show HN은 본문 글이 아예 없다(230건 중 129건). 이걸 "파싱 실패"로 오인해 LLM 요약을 붙이고 싶어지는 지점인데, 프로젝트 제약상 금지다. UI에서 title만 있는 카드를 자연스럽게 렌더링하도록 설계할 것.

7. **`_highlightResult`를 파싱 대상으로 착각하지 말 것.** hit 객체의 첫 번째 키라 눈에 먼저 띄고 title/url/story_text를 전부 중복으로 담고 있다. 여기 값들은 검색 하이라이팅용이라 `<em>` 마크업이 끼어들 수 있다. 항상 top-level 필드를 쓴다.

8. **정렬은 created_at_i 내림차순으로 보장된다**(전수 검증). 하지만 이걸 믿고 페이지네이션 경계를 자르지 말 것. 우리는 어차피 전량을 받아 id로 dedupe하므로 정렬에 의존하는 로직을 만들 이유가 없다.

9. **`numericFilters`는 `>` 이므로 경계값 배타적**이고, 반드시 URL 인코딩(`%3E`)해야 한다. 날것 `>`는 일부 HTTP 클라이언트/셸에서 깨진다. `encodeURIComponent('created_at_i>' + since)` 를 쓸 것.

10. **일 볼륨이 다른 소스 전체의 5배**(139~156건/일). JSON 크기는 아이템당 약 420바이트, 하루 ~64KB, 1년 ~23MB. 전부 한 파일에 넣으면 GitHub Pages에서 폰이 매번 23MB를 받게 된다. **월별 또는 일별 샤딩 필수**(예 `data/2026-07.json`), 그리고 "오늘"은 별도의 작은 파일로 분리할 것. 검색은 최근 N개월만 lazy load.

11. **collectedAt 보존이 이 소스에서 가장 치명적이다.** 96시간 창이므로 매 실행마다 같은 아이템을 3~4번 다시 본다. 병합에서 기존 id의 collectedAt을 갱신하면 매일 600건이 "오늘 새로운 것"으로 뜬다. 기존 id는 **필드 갱신 없이 통째로 스킵**하는 게 정답이다(points/댓글수가 변해도 무시 — 아카이브는 최초 관측 스냅샷).

12. **`"Show HN: "` 접두사를 제거하지 말 것.** 원본 보존 원칙이기도 하지만, 실제로 `"Show NH: +135 files converter..."` 같은 오타 제목과 제목이 `"Show HN"` 뿐인 글이 존재해서 안전한 제거 정규식을 만들 수 없다. 표시 단계에서 CSS로 처리하고 싶으면 그때 하되 저장 값은 원본 유지.

13. **`front_page` 태그는 시점에 따라 붙었다 떨어진다**(230건 중 3건). 필터 조건으로 쓰지 말 것. 우리는 인기와 무관하게 전량 수집한다.

14. **collectedAt은 배치당 1개 값**을 루프 밖에서 만들어 쓸 것. 아이템마다 `new Date()`를 호출하면 같은 배치가 밀리초 단위로 흩어져 "오늘 새로운 것" 정렬이 실행마다 미세하게 달라진다.

15. GitHub Actions cron은 KST 06:00 = **UTC 21:00 (전날)**. `- cron: '0 21 * * *'`. 그리고 Actions schedule은 흔히 5~30분, 혼잡 시 몇 시간까지 지연된다 — 96시간 창이 이걸 전부 흡수하므로 지연 자체는 무시해도 된다.
