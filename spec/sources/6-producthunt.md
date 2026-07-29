# Product Hunt (`producthunt`)

> 이 문서는 2026-07-29에 **실제 HTTP 응답을 받아** 작성된 수집 계약이다.
> 추측이 아니라 실측이며, `sampleItem`은 그날 받은 진짜 데이터다.
> 사이트가 바뀌면 이 문서를 먼저 고치고 코드를 고친다.

## 일일 물량

하루 8~13건 (정상 범위 5~20건). 2026-07-29 03:41 UTC 스냅샷 1회의 published 날짜 히스토그램 실측: 07-27=13, 07-26=9, 07-25=3, 07-24=7, 07-23=2, 07-22=2, 나머지는 07-21 이전 꼬리(총 50건, 최고령 2025-11-28). 즉 피드 50건은 대략 최근 3~5일치 런치를 덮는다 → 하루치 실행을 2~3회 놓쳐도 다음 실행에서 자동 복구된다.

## 요청

GET https://www.producthunt.com/feed

헤더 (3개 모두 보낼 것):
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36
  Accept: application/atom+xml, application/xml;q=0.9, */*;q=0.8
  Accept-Language: en-US,en;q=0.9

페이지 수: 1회 요청만. 페이지네이션 없음 — 이 URL은 항상 정확히 50 entry를 준다. 쿼리스트링/토큰/쿠키/인증 전부 불필요.

실측 응답 (2026-07-29T03:41:46Z):
  HTTP/2 200
  content-type: application/atom+xml; charset=utf-8
  content-length: 43998
  etag: W/"f355f5e662a643c3ea5ef5ec5d4230eb"
  last-modified: Wed, 29 Jul 2026 03:41:41 GMT
  cache-control: public, max-age=30
  cf-cache-status: HIT
  server: cloudflare
  set-cookie: __cf_bm=... (무시해도 됨. 쿠키 재전송 불필요)

Node 구현 예:
  const res = await fetch("https://www.producthunt.com/feed", { headers: { "User-Agent": UA, "Accept": "application/atom+xml, application/xml;q=0.9, */*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
  const xml = await res.text();

타임아웃 15초, 실패 시 재시도 3회(백오프 2s → 8s). 브라우저 UA 없이도 이번 테스트에선 200이 나왔지만(기본 curl UA로도 200/43998바이트), GitHub Actions IP는 Cloudflare 챌린지를 받을 확률이 높으므로 UA는 반드시 넣는다.

**절대 하지 말 것**: /r/p/{id} 를 서버에서 따라가지 마라. 실측 결과 브라우저 헤더를 다 붙여도 HTTP 403 + `cf-mitigated: challenge` 를 반환한다. externalUrl은 해석하지 말고 문자열 그대로 저장한다.

## 파싱 절차

전제: 응답은 Atom 1.0 (`xmlns="http://www.w3.org/2005/Atom"`). RSS 2.0 아님 — `<item>`, `<pubDate>`, `<guid>`, `<description>` 태그는 존재하지 않는다. 아래는 의존성 없이 정규식으로 파싱하는 절차(실제 바이트로 검증됨). Atom 파서 라이브러리를 쓰더라도 3~7단계의 content 처리 로직은 동일하게 필요하다.

0. 유틸 2개를 먼저 정의한다.
   - `unescapeXml(s)` = `&lt;`→`<`, `&gt;`→`>`, `&quot;`→`"`, `&apos;`→`'`, `&#39;`→`'`, 그리고 **마지막에** `&amp;`→`&`. (`&amp;`를 먼저 치환하면 이중 이스케이프가 깨진다.)
   - `collapse(s)` = `s.replace(/\s+/g, " ").trim()`

1. 엔트리 분리: `const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1])`
   → 실측 50개. 피드 레벨의 `<id>`, `<title>`, `<link>`는 `<entry>` 밖에 있으므로 이 스코프 분리로 자동 배제된다.

2. 네이티브 ID: 각 entry에 대해 `/<id>tag:www\.producthunt\.com,2005:Post\/(\d+)<\/id>/` 매치. 캡처값이 네이티브 ID(예: `1205332`). 매치 실패한 entry는 **버린다**(카운트만 남겨 헬스체크에 쓴다).

3. 제목: `/<title>([\s\S]*?)<\/title>/` → `collapse(unescapeXml(m[1]))`. 빈 문자열이면 그 entry는 버린다. (제목에 엔티티가 들어오는 경우 실측됨: `&gt;=PlayingFild` → `>=PlayingFild`)

4. 캐노니컬 URL: `/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/` → `unescapeXml(m[1])`. entry당 `<link>`는 1개뿐이며 실측 50/50 모두 `https://www.producthunt.com/products/{slug}` 형태였다. utm 파라미터 없음 — 그대로 쓴다.

5. content 추출: `/<content type="html">([\s\S]*?)<\/content>/` → `const html = unescapeXml(m[1])`. 이제 `html`은 실제 HTML 문자열이다. 실측상 항상 `<p>` 2개로 구성된다: 첫 번째 = 한줄설명, 두 번째 = `<a>Discussion</a> | <a>Link</a>` 내비게이션.

6. 한줄설명: `html`에서 `/<p>([\s\S]*?)<\/p>/` **첫 매치만** 사용 → 태그 제거 `.replace(/<[^>]+>/g, "")` → `unescapeXml` 한 번 더 적용(HTML 레벨 엔티티) → `collapse`. 결과 예: `Build websites with AI`, `A workspace & 2nd brain for you, your agent, and your team`. 매치가 없으면 `""`.
   ※ `<p>` 전체 텍스트를 합치면 `Discussion | Link` 쓰레기가 붙는다. 반드시 첫 `<p>`만.

7. externalUrl: `html`에서 `/href="(https:\/\/www\.producthunt\.com\/r\/p\/\d+[^"]*)"/` 첫 매치 → `unescapeXml(m[1])` (원본은 `&amp;amp;`로 이중 이스케이프되어 있을 수 있음). 결과 예: `https://www.producthunt.com/r/p/1205332?app_id=339`. 매치 없으면 필드를 생략한다. **HTTP로 따라가지 않는다.**

8. publishedAt: `/<published>([^<]+)<\/published>/` → `new Date(m[1]).toISOString()`. 원본은 `2026-07-24T01:32:37-07:00` 같은 태평양시(-07:00/-08:00 DST 변동). `Invalid Date`면 필드 생략. `<updated>`는 사용하지 않는다.

9. 아이템 조립: `id = "producthunt:" + 네이티브ID`, `source = "producthunt"`, `collectedAt = 실행 시작 시각` (런당 1번만 계산해 전 아이템에 동일 값 주입).

10. 정렬/필터: **하지 않는다.** 피드 순서 그대로 반환한다. 날짜 필터 절대 금지(2번 gotcha 참조). 중복 제거는 상위 파이프라인이 아카이브 전체의 `id` 집합으로만 수행한다. 이번 실측에서 피드 내부 id 중복은 0건이었으나, 방어적으로 파서 반환 직전 `id` 기준 1회 dedupe(선착순 유지)를 넣어도 무해하다.

## 필드 매핑

id           ← `"producthunt:" + <entry><id>의 Post/(\d+) 캡처값`
               예: `tag:www.producthunt.com,2005:Post/1205332` → `producthunt:1205332`
               이 숫자는 PH의 Post ID로 영구 불변. 제품이 재런치되면 **새 Post ID**가 발급되므로 slug/title이 같아도 별개 아이템으로 들어온다(의도된 동작).
source       ← 상수 `"producthunt"`
title        ← `<entry><title>` (XML 언이스케이프 + 공백 정규화). 빈 값이면 아이템 폐기.
description  ← `<content>` HTML의 **첫 번째 `<p>` 텍스트** (태그 스트리핑 + 엔티티 2단 디코딩 + 공백 정규화).
               없으면 `""` (스키마상 허용). 실측 50/50 모두 존재, 길이 22~60자.
url          ← `<entry><link rel="alternate" href>` = `https://www.producthunt.com/products/{slug}` (PH 내 제품/토론 페이지). 그대로 사용, 파라미터 추가 금지.
externalUrl  ← `<content>` 내 `https://www.producthunt.com/r/p/{네이티브ID}?app_id=339` 링크. **실제 제품 사이트가 아니라 PH 리다이렉트 URL**이다(브라우저에서 열면 제품 사이트로 감). 해석 불가하므로 그대로 저장. 매치 실패 시 필드 자체를 생략(undefined). 진짜 제품 도메인을 원치 않으면 이 필드를 아예 빼도 계약 위반 아님 — 단 팀 내에서 한쪽으로 통일할 것.
publishedAt  ← `<entry><published>` → UTC ISO8601로 정규화. **표시용일 뿐 신뢰 금지** (수개월 전 날짜가 섞임). 파싱 실패 시 생략.
collectedAt  ← 컬렉터 런 시작 시각 `new Date().toISOString()`. 런 내 모든 아이템 동일 값. "오늘 새로 들어온 것" 정렬의 유일한 기준.
(미사용 필드) `<entry><updated>`, `<author><name>` — 스키마에 자리가 없으므로 버린다. content의 두 번째 `<p>`(Discussion|Link)도 전량 폐기.

## 실제 샘플

2026-07-29T03:41:01Z에 https://www.producthunt.com/feed 를 실제 호출해 받은 첫 번째 entry를 위 규칙으로 변환한 결과 (원본: `<id>tag:www.producthunt.com,2005:Post/1205332</id>`, `<published>2026-07-24T01:32:37-07:00</published>`):

{
  "id": "producthunt:1205332",
  "source": "producthunt",
  "title": "Ycode AI Agents",
  "description": "Build websites with AI",
  "url": "https://www.producthunt.com/products/ycode",
  "externalUrl": "https://www.producthunt.com/r/p/1205332?app_id=339",
  "publishedAt": "2026-07-24T08:32:37Z",
  "collectedAt": "2026-07-29T03:41:01Z"
}

같은 응답의 다른 실측 아이템 2건 (엔티티 디코딩/이모지 케이스 회귀 테스트용):

{
  "id": "producthunt:1207877",
  "source": "producthunt",
  "title": "Growth Opt Playbook",
  "description": "Turn campaign data into your next marketing move",
  "url": "https://www.producthunt.com/products/growth-opt-playbook",
  "externalUrl": "https://www.producthunt.com/r/p/1207877?app_id=339",
  "publishedAt": "2026-07-27T13:18:23Z",
  "collectedAt": "2026-07-29T03:41:01Z"
}

description 원본이 `A workspace &amp; 2nd brain for you, your agent, and your team` 로 이스케이프되어 있던 entry(index 22, title "Liminal")는 디코딩 후 `A workspace & 2nd brain for you, your agent, and your team` 가 되어야 한다. 이모지 케이스: `Build your business idea with unlimited Fable/Sol credits ♾️` (60자, 최장) — UTF-8 그대로 보존할 것.

## healthCheck

런 실패로 간주할 하드 단언 (하나라도 false면 이 소스는 실패 처리, 기존 아카이브는 건드리지 않음):

H1. `res.status === 200`
H2. `res.headers.get("content-type")` 가 `"atom+xml"` 를 포함 (실측: `application/atom+xml; charset=utf-8`). HTML이 오면 Cloudflare 챌린지 페이지다.
H3. `xml.length > 10000` (실측 43,998바이트) **그리고** `xml.trimStart().startsWith("<?xml")`
H4. `xml.includes('xmlns="http://www.w3.org/2005/Atom"')` — 이게 깨지면 PH가 포맷을 RSS로 바꾼 것이므로 파서 전면 재작성 신호.
H5. `rawEntryCount = (xml.match(/<entry>/g) ?? []).length` 가 `>= 20` (기대값 정확히 50). 20 미만이면 실패.
H6. `items.length >= 20` — **파싱 결과 0건이면 무조건 실패**. 추가로 `items.length >= rawEntryCount * 0.9` (엔트리→아이템 매핑 손실 10% 초과 시 실패).
H7. `new Set(items.map(i => i.id)).size === items.length` (단일 응답 내 id 중복 0건, 실측 확인)
H8. 모든 아이템에 대해 `/^producthunt:\d{4,9}$/.test(item.id)` && `item.title.length > 0` && `item.url.startsWith("https://www.producthunt.com/")`
H9. `items.filter(i => i.description !== "").length / items.length >= 0.8` (실측 50/50 = 1.00). 이 비율이 무너지면 content의 `<p>` 구조가 바뀐 것.

경고(런은 성공 처리하되 로그/이슈로 남길 소프트 단언):
S1. `rawEntryCount !== 50` → PH가 피드 크기를 바꿨을 수 있음.
S2. `items.filter(i => i.externalUrl).length / items.length < 0.8` (실측 1.00) → `/r/p/` 링크 형식 변경 의심.
S3. 아카이브 dedupe 후 **신규 0건이 2일 연속** 발생 → PH는 하루 8~13건을 올리므로 정상 아님. 단, 1회성 0건은 정상일 수 있으니 실패로 만들지 말 것(cron 중복 실행, 타이밍 등).
S4. 신규 건수가 하루 30건을 넘음 → 피드 순서/구성 변경 또는 dedupe 키 파손 의심.

## 폴백

1차 폴백 (같은 URL 재시도): 5xx / 403 / 429 / 타임아웃 / H2·H3 위반 시 2초 → 8초 백오프로 최대 3회 재시도. 2·3회차에는 User-Agent를 다른 브라우저 문자열로 교체(예: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36`). Cloudflare 챌린지는 대개 일시적이다.

2차 폴백 (검증된 대체 URL): `https://www.producthunt.com/feed?category=tech`
  - 실측(2026-07-29): HTTP 200, `application/atom+xml`, **entry 50개**, 스키마/파서 100% 동일(`tag:...Post/{숫자}` 동일 네임스페이스라 id dedupe가 그대로 맞물림).
  - 단, 메인 피드와 **겹치는 항목이 50개 중 1개뿐**이고 published가 더 오래된 쪽으로 치우친다(스냅샷 최신 = 07-26). 즉 "오늘의 런치"를 대체하지는 못하고 누락 보전용이다. 메인 피드가 죽었을 때만 쓰고, 평시에 합치지는 말 것(가공 없음 원칙과는 무관하지만 볼륨 왜곡).
  - `https://www.producthunt.com/feed.atom` 은 404다. 쓰지 마라.

3차 폴백 (그냥 건너뛰기 — 권장): 위가 다 실패하면 **이번 런에서 producthunt 소스를 스킵하고 기존 JSON을 그대로 둔다.** 빈 배열을 커밋해 그날을 "0건"으로 확정짓지 말 것. 근거: 피드 50건이 최근 3~5일치를 덮으므로 연속 2~3회 실패해도 복구 시점에 놓친 항목이 전부 신규 id로 들어온다. 워크플로는 `continue-on-error`로 다른 소스 수집을 막지 않게 하고, 실패 사실만 로그/스텝 서머리에 남긴다.

4차(수동, 자동화 대상 아님): PH 공식 GraphQL API(https://api.producthunt.com/v2/api/graphql)는 개발자 토큰이 필요해 public repo + 시크릿 없음 제약과 충돌한다. 3일 이상 연속 실패가 이어지면 그때 사람이 판단할 옵션으로만 남겨둔다.

## 함정

G1. **Atom이지 RSS 2.0이 아니다.** `<item>`/`<pubDate>`/`<guid>`/`<description>`은 존재하지 않는다. rss-parser 등을 RSS2 가정으로 붙이면 조용히 0건을 반환한다(그래서 H6의 "0건=실패"가 필수).

G2. **날짜로 필터링하면 안 된다.** 피드 정렬은 featured/updated 기준이라 published가 내림차순이 아니다(실측: 단조 감소 아님). 같은 스냅샷에 2026-07-27과 2025-11-28이 공존했다. "어제 이후만" 같은 컷오프나 "오래된 항목 나오면 break" 최적화를 넣는 순간 오늘의 신규를 놓친다. **오직 id dedupe만.** 그래서 오래된 published를 가진 항목이 오늘 아카이브에 처음 등장하는 건 버그가 아니라 정상이며, 화면 정렬은 collectedAt으로 한다.

G3. **url은 post 페이지가 아니라 product 페이지다.** `https://www.producthunt.com/products/{slug}` 형태(실측 50/50). 같은 제품이 재런치되면 Post ID는 다르지만 url이 동일해진다 → **url이나 title로 dedupe하지 마라.** id(Post ID)만이 고유 키다.

G4. **이스케이프가 2단이다.** XML 텍스트 노드를 디코드하면 HTML 문자열이 나오고, 그 안에서 태그를 벗긴 뒤 한 번 더 엔티티 디코딩이 필요하다. content 내부 href는 원본에 `&amp;amp;`로 들어있다. 언이스케이프 치환 순서에서 `&amp;`를 **맨 마지막**에 처리하지 않으면 `&amp;lt;` 같은 값이 깨진다.

G5. **`/r/p/{id}`를 서버에서 호출하지 마라.** 브라우저 UA + Accept + Accept-Language를 다 붙여도 `HTTP/2 403` + `cf-mitigated: challenge`가 돌아온다(실측). 실제 제품 도메인을 얻겠다고 리다이렉트를 따라가면 GH Actions에서 매번 실패하고, 최악의 경우 메인 피드까지 IP 차단당한다. externalUrl은 문자열 그대로 저장한다.

G6. **content의 `<p>`는 항상 2개** (실측 50/50). 두 번째는 `Discussion | Link` 내비게이션이다. innerText 전체를 쓰면 모든 설명 끝에 `Discussion | Link`가 붙는다. 첫 `<p>`만.

G7. **한줄설명은 잘려 있지 않다.** 실측 길이 22~60자, 말줄임(`...`/`…`)으로 끝나는 항목 0건. 즉 "잘렸으니 원문 페이지를 더 긁자"는 유혹에 빠지지 말 것 — 가공 금지 원칙에도 맞고 요청 수도 1회로 유지된다.

G8. **UTF-8/이모지 보존.** 설명에 `♾️` 같은 이모지와 비ASCII가 들어온다. 응답을 `res.text()`로 받고(수동 latin1 디코딩 금지) JSON은 `ensure_ascii` 없이 그대로 쓴다. 제목에도 엔티티가 온다(실측 `&gt;=PlayingFild`).

G9. **타임존.** published는 `-07:00`/`-08:00`(미국 태평양시, DST에 따라 바뀜)로 온다. 저장 전에 UTC ISO8601로 정규화하지 않으면 아카이브에 두 종류 오프셋이 섞인다. KST 06:00 cron 기준 "어제"와 PH의 "오늘"은 애초에 다른 날이라는 점도 UI 문구 쓸 때 감안할 것.

G10. **캐시.** `cache-control: public, max-age=30`, `cf-cache-status: HIT`. 최대 30초 stale일 수 있으나 하루 1회 크론에는 무의미하다. ETag/Last-Modified가 제공되지만 조건부 GET(If-None-Match)으로 304를 받아 스킵하는 로직은 넣지 마라 — 하루 간격에선 항상 200이고, 괜히 304를 "실패"로 오판할 여지만 생긴다.

G11. **정확히 50건 고정.** 페이지네이션 파라미터를 추측해서 더 긁으려 하지 마라(비공개 API 탐색 금지 원칙). 50건 × 하루 ~11건 = 약 3~5일 커버리지라 하루 1회 크론으로 충분하다.

G12. **응답 헤더를 파일로 덤프해 읽을 때 주의.** 이 환경에서 `curl -D file` 로 받은 첫 헤더 덤프가 프록시 헤더(`content-type: application/json`, `server: Google Frontend`)로 오염된 적이 있다. 실제 오리진 헤더는 `application/atom+xml; charset=utf-8` / `server: cloudflare` 다. H2를 구현할 때는 fetch 응답 객체의 헤더를 직접 보라.
