# Disquiet (`disquiet`)

> 이 문서는 2026-07-29에 **실제 HTTP 응답을 받아** 작성된 수집 계약이다.
> 추측이 아니라 실측이며, `sampleItem`은 그날 받은 진짜 데이터다.
> 사이트가 바뀌면 이 문서를 먼저 고치고 코드를 고친다.

## 일일 물량

신규 8~10건/일 수준. 단, 실제로는 균등하지 않고 배치 승인이라 몰려 들어온다. 2026-07-29 03:40 UTC 실측 결과 page 1+2의 40건(id 7484~7536)의 approved_at이 전부 2026-07-26 22:24:25~22:24:45Z(1초 간격)로 동일 배치였다. 즉 어떤 날은 0건, 어떤 날은 20~40건이 한꺼번에 잡힐 수 있다. page 1~2(최대 40건)면 하루치는 항상 커버되지만, 안전마진을 원하면 page 3까지 늘려도 비용은 무시할 만하다.

## 요청

GET https://disquiet.io/products.json?page=1
GET https://disquiet.io/products.json?page=2

- 인증 없음. 쿠키 불필요(응답이 _session_id를 Set-Cookie 하지만 무시해도 됨).
- 필수 헤더:
    User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36
    Accept: application/json
- 페이지 수: 2페이지 고정(40건). page 파라미터만 유효하고 per_page/limit은 무시된다.
- 두 요청 사이 300~1000ms 슬립. 타임아웃 15s, 실패 시 지수백오프로 최대 2회 재시도.
- 응답: HTTP/2 200, content-type: application/json; charset=utf-8, 최상위가 배열. page1 실측 31,536바이트 / 20건, page2 26,002바이트 / 20건.
- ETag(W/"...")를 주므로 원하면 If-None-Match로 304를 받을 수 있으나, 하루 1회 실행이라 굳이 쓸 필요 없음.

참고 예시(그대로 복붙 가능):
curl -s -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' -H 'Accept: application/json' 'https://disquiet.io/products.json?page=1'

## 파싱 절차

1. page = 1, 2 각각에 대해 위 GET을 보낸다. res.status !== 200이면 그 페이지는 실패로 처리하고(throw) 나머지로 진행하지 않는다.
2. `const arr = await res.json()`. `Array.isArray(arr)`가 false면 계약 파손으로 간주하고 throw. (JSON 경로: 루트 자체가 배열 — `$` 가 곧 아이템 배열이다. `$.data`, `$.products` 같은 래퍼는 없다.)
3. page1 배열과 page2 배열을 concat한다. 최대 40건.
4. 각 원소 p에 대해 필수 필드를 검증한다: `typeof p.id === 'number' && Number.isInteger(p.id) && typeof p.slug === 'string' && p.slug.length > 0 && typeof p.name === 'string' && p.name.length > 0`. 하나라도 실패하면 그 원소만 skip하고 카운트해 둔다(전체 실패로 만들지 않는다).
5. dedupe: `new Map()`에 `p.id`를 키로 넣어 중복 제거. 같은 id가 두 번 나오면 먼저 나온 것(=page1 쪽, id가 더 큰 페이지)을 유지. 실측상 page1∩page2 = 0건이지만 페이지 경계에서 새 글이 들어오면 밀려서 중복이 생길 수 있다.
6. 각 p를 아래 fieldMapping 규칙으로 공통 스키마 아이템으로 변환한다.
7. 변환 결과를 저장소의 기존 id 집합(`disquiet:*`)과 대조해 처음 보는 것만 신규로 취급하고, 신규 아이템에만 `collectedAt = new Date().toISOString()`을 찍는다. 이미 있던 id는 collectedAt을 절대 덮어쓰지 않는다.
8. 반환 정렬은 원본 배열 순서(= id 내림차순, 최신 우선)를 그대로 유지한다. approved_at으로 재정렬하지 말 것.

정규식 모음:
- Disquiet 상세 URL 생성: `https://disquiet.io/products/${encodeURIComponent(p.slug)}`
- 절대 URL 판정: `/^https?:\/\//i.test(p.url)`
- 공백 정규화: `s.replace(/\s+/g, ' ').trim()`

## 필드 매핑

소스 아이템 p의 필드는 정확히 7개: id(number), slug(string), name(string), tagline(string), description(string, 긴 본문), url(string, 제품 자체 사이트), approved_at(string ISO8601 Z).

- id        ← `` `disquiet:${p.id}` ``  // 예: "disquiet:7536". p.id는 number이므로 템플릿 문자열로 강제 변환. slug는 절대 id에 쓰지 말 것(변경 가능성 있음).
- source    ← 리터럴 `"disquiet"`
- title     ← `p.name.replace(/\s+/g,' ').trim()`
- description ← `(p.tagline ?? '').replace(/\s+/g,' ').trim()`  // ★주의: 소스의 `description` 필드가 아니라 `tagline`이 우리의 한줄설명이다. 소스 `description`은 최대 1233자짜리 마크다운/개행 본문이라 버린다(가공 금지 원칙상 요약도 하지 않는다).
- url       ← `` `https://disquiet.io/products/${encodeURIComponent(p.slug)}` ``  // 캐노니컬. slug에 한글이 들어오는 경우가 있어 encodeURIComponent 필수.
- externalUrl ← `/^https?:\/\//i.test(p.url) ? p.url : undefined`  // p.url이 빈 문자열/상대경로면 필드 자체를 넣지 않는다.
- publishedAt ← `p.approved_at || undefined`  // 이미 "2026-07-26T22:24:25.581Z" 형태의 ISO8601 UTC라 변환 불필요. 표시용으로만 쓰고 신규 판별에 절대 쓰지 않는다.
- collectedAt ← 이 id를 저장소에서 처음 볼 때의 `new Date().toISOString()`. 기존 아이템은 보존.

빠진 필드 처리:
- tagline이 비면 description = "" (실측 40건 모두 비어있지 않았지만 방어).
- p.url이 없으면 externalUrl 키를 아예 생략(빈 문자열 넣지 말 것).
- approved_at이 없으면 publishedAt 생략 — 아이템은 그래도 유효하다.

## 실제 샘플

{
  "id": "disquiet:7536",
  "source": "disquiet",
  "title": "코드블루 - 심리 설계 기반 후불제 웹사이트 제작",
  "description": "만족하지 않으면 0원. 병원·소상공인·쇼핑몰을 위한 전환율 중심 후불제 홈페이지",
  "url": "https://disquiet.io/products/582396d0-5867-46a8-aa0e-18b12337fa3b",
  "externalUrl": "https://www.codeblue-official.co.kr/",
  "publishedAt": "2026-07-26T22:24:25.581Z",
  "collectedAt": "2026-07-29T03:40:57.000Z"
}

(2026-07-29 03:40:57 UTC에 https://disquiet.io/products.json?page=1 을 실제 호출해 받은 배열의 [0] 원본:
 {"id":7536,"slug":"582396d0-5867-46a8-aa0e-18b12337fa3b","name":"코드블루 - 심리 설계 기반 후불제 웹사이트 제작","tagline":"만족하지 않으면 0원. 병원·소상공인·쇼핑몰을 위한 전환율 중심 후불제 홈페이지","description":"사이트 객관적인 피드백 부탁드립니다!\r\n사이트 주소 : https://www.codeblue-official.co.kr/ ...(1200자 생략)","url":"https://www.codeblue-official.co.kr/","approved_at":"2026-07-26T22:24:25.581Z"}
 상세 페이지 https://disquiet.io/products/582396d0-5867-46a8-aa0e-18b12337fa3b 는 HTTP 200 확인.)

## healthCheck

아래가 전부 참이면 정상. 하나라도 거짓이면 이 소스는 broken으로 마킹하고 해당 실행의 disquiet 결과를 버린다(빈 배열로 커밋해서 기존 아카이브를 덮어쓰지 말 것).

1. page=1 응답이 `res.status === 200` 이고 `res.headers.get('content-type')`가 `application/json`을 포함한다.
2. `Array.isArray(json) === true` (루트가 배열).
3. `json.length >= 10` (실측 20. 20 미만이어도 동작은 하지만 10 미만이면 이상 신호).
4. `json.every(p => Number.isInteger(p.id) && typeof p.slug === 'string' && p.slug.length > 0 && typeof p.name === 'string' && p.name.trim().length > 0)`.
5. page1의 id가 내림차순: `json.every((p,i) => i === 0 || json[i-1].id > p.id)`.
6. page1의 최대 id가 마지막 성공 실행에서 기록해 둔 max id보다 **작지 않다**: `maxId >= lastKnownMaxId`. 작아지면 정렬 규칙이 바뀐 것(예: 랜덤 정렬 페이지로 떨어짐)이므로 실패.
7. 최종 변환 아이템 수 `items.length >= 1`. **파싱 결과 0건이면 무조건 실패로 간주한다.**
8. 모든 아이템의 `url`이 `^https://disquiet\.io/products/.+` 를 만족하고 `id`가 `^disquiet:\d+$` 를 만족한다.
9. (경고 수준, 실패는 아님) 신규 id가 0건인 날은 정상일 수 있다 — 배치 승인이라 며칠 0건이 이어질 수 있다. 다만 **연속 7일 신규 0건**이면 알림/이슈를 남긴다.
10. (경고 수준) tagline이 빈 아이템이 전체의 50%를 넘으면 필드 의미가 바뀌었을 가능성 → 로그 경고.

운영 팁: max id를 `data/state/disquiet.json` 같은 곳에 `{"lastMaxId":7536,"lastOkAt":"..."}`로 커밋해 두면 6번과 9번을 그대로 코드로 옮길 수 있다.

## 폴백

1차(products.json)가 깨졌을 때 순서대로:

1. **1차 재시도 변형**: `?page=1` 없이 `https://disquiet.io/products.json` 을 그대로 호출. Rails 관례상 page 기본값 1로 같은 결과를 준다. 403/429면 UA를 다른 브라우저 문자열로 바꾸고 60초 후 1회 재시도.
2. **HTML 폴백**: `GET https://disquiet.io/products` 를 브라우저 UA로 받아 HTML에서 상세 링크를 긁는다.
   - 링크 추출: `/href="\/products\/([^"?#]+)"/g` → 캡처그룹을 decodeURIComponent 한 slug 집합.
   - 이 경로에는 native numeric id가 없다. 이 경우에만 id를 `disquiet:slug:{slug}`로 만들고(숫자 id 네임스페이스와 절대 섞지 말 것), 나중에 products.json이 복구되면 두 경로에서 온 같은 제품이 중복으로 남을 수 있음을 감수한다. 제목은 링크 앵커 텍스트, description은 "" 로 둔다.
   - HTML 폴백은 "완전 실패보다 낫다" 수준이므로 아이템에 `source: "disquiet"`는 유지하되 로그에 fallback 사용을 남긴다.
3. **그래도 실패하면**: disquiet 소스를 이번 실행에서 스킵한다. 기존 아카이브 JSON은 그대로 두고, 실행 로그/GitHub Actions summary에 실패를 기록한다. 다른 소스 수집은 계속 진행한다(한 소스 실패가 전체 잡을 죽이면 안 됨).

RSS/Atom 공식 피드는 확인된 것이 없으므로 의존하지 않는다.

## 함정

- **`description` 필드 함정(제일 중요)**: 소스의 `description`은 한줄설명이 아니라 최대 1200자가 넘는 긴 본문이다(실측 최대 1233자). 우리 스키마의 description에는 반드시 `tagline`을 넣는다(실측 최대 107자).
- **`url` 필드는 Disquiet 링크가 아니다**: p.url은 제품 자체 사이트(예: `https://www.codeblue-official.co.kr/`, `https://chromewebstore.google.com/detail/...`)다. 이건 externalUrl로 가고, 우리 url은 `https://disquiet.io/products/{slug}`로 직접 조립해야 한다.
- **slug에 한글이 온다**: 실측으로 `슬리드`, `이지로직-스튜디오`, `오르락`, `마니또`, `더리치` 같은 non-ASCII slug가 존재한다. `encodeURIComponent(slug)` 없이 URL을 만들면 링크가 깨진다. 반대로 이미 인코딩된 값을 다시 인코딩하지 않도록 slug는 raw 그대로 한 번만 인코딩한다.
- **slug 형식이 두 종류**: UUID형(`582396d0-5867-46a8-aa0e-18b12337fa3b`)과 사람이 읽는 형(`itinr`, `korea-ai-pulse`, `wehome`)이 섞여 있다. 형식으로 검증하려 들지 말고 "비어있지 않은 문자열"만 확인.
- **id에 구멍이 있다**: 실측 page1 = 7536,7535,...,7522,7517,7516,7515,7513,7510 처럼 중간 id가 빠진다(삭제/미승인). "id가 1씩 증가한다"는 가정으로 놓친 항목을 채우려 하면 안 된다. 반드시 페이지를 읽어서 확인.
- **approved_at은 신규 판별 불가**: 배치 승인이라 40건이 전부 `2026-07-26T22:24:25.581Z` ~ `...:45.405Z`로 1초 간격 연속이다. 날짜 비교나 "어제 이후" 필터로 신규를 판정하면 하루는 0건, 하루는 40건이 된다. **오직 id(=우리 id 문자열) 기준 dedupe만 사용.** 정렬도 collectedAt 기준.
- **본문에 CRLF**: description(우리가 버리는 필드)의 34/40이 `\r\n`을 포함한다. 혹시라도 저장한다면 개행 정규화 필요. tagline에도 방어적으로 `\s+ → ' '` 정규화를 걸어라.
- **page 파라미터가 범위 밖이면 조용히 이상해진다**: `?page=999` 는 404나 빈 배열이 아니라 **HTTP 200에 18건**을 돌려주고, 그 순서는 id 내림차순이 아니다(실측 1736, 906, 2134, 4564, 2375, ... 사실상 랜덤). 따라서 "빈 배열이 나올 때까지 페이지를 늘린다"는 루프를 절대 쓰지 말 것 — 무한루프 + 오래된 항목 오염이 난다. page는 1~2로 하드코딩한다. id 내림차순 가정은 앞쪽 페이지에서만 성립한다.
- **per_page/limit 무시**: 어떤 값을 줘도 페이지당 20건. 단 항상 정확히 20은 아니다(page=999는 18건) → 길이로 페이지 유효성을 판단하지 말 것.
- **HTML 엔티티/태그 없음**: 실측 40건의 name/tagline에 `&amp;` 류 엔티티나 `<tag>`가 하나도 없었다. 그래도 사이트에 렌더링할 때는 innerHTML 대신 textContent를 써라.
- **Cloudflare 뒤에 있다**: server: cloudflare, cf-cache-status: DYNAMIC. UA를 비우거나 curl 기본 UA로 두면 차단될 수 있으니 브라우저 UA 필수. GitHub Actions IP에서 간헐적 429가 날 수 있으므로 재시도 백오프를 넣어라.
- **응답이 Set-Cookie(_session_id)를 준다**: 저장할 필요 없고, 세션 재사용도 불필요하다. 요청마다 무상태로 보내면 된다.
- **cache-control: max-age=0, private, must-revalidate**: 중간 캐시가 없으니 매번 최신이다. ETag는 있으므로 필요하면 조건부 요청 가능.
