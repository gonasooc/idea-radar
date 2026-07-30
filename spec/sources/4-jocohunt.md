# 조코헌트 (jocoHunt) (`jocohunt`)

> 이 문서는 2026-07-29에 **실제 HTTP 응답을 받아** 작성된 수집 계약이다.
> 추측이 아니라 실측이며, `sampleItem`은 그날 받은 진짜 데이터다.
> 사이트가 바뀌면 이 문서를 먼저 고치고 코드를 고친다.

> ## ⚠ 2026-07-30 변경: 홈 products 배열이 항상 비어 있다
>
> 사이트가 홈을 개편했다. "방금 올라온 프로덕트" 컴포넌트가 탭 방식(인기순/최신순/토론 많은)이 되면서 **SSR 페이로드가 `"products":[]`로 고정**됐고, 실제 제품은 "반응을 기다려요" 섹션에 **이미 렌더된 RSC 엘리먼트 트리**(`["$","div","jqi2g7na",{...}]`)로만 남았다. 깔끔한 props 배열은 사라졌다.
>
> **파서는 멀쩡하다.** 2026-07-30 실측: flight 청크 70개(전 73), flight 길이 138,682(전 144,002), `"products":[` 인덱스 82,777에서 발견, 괄호 밸런싱 정상. 배열이 진짜로 비어 있을 뿐이다.
>
> 그래서 **A 경로(홈 메타데이터)는 사실상 죽었고, F1(sitemap + 상세 og)이 상시 경로가 됐다.** 아래 A절과 H11은 히스토리로 남겨 두되, 현재 동작은 F1이다. 코드는 빈 배열을 파싱 실패로 보지 않는다 — throw 하면 매 실행 경고가 떠서 SPEC 4.2가 경고하는 "알림 무시" 상태를 만든다.
>
> **손실은 없다.** 2026-07-30 검증: 홈에 보이는 실제 제품 6건이 전부 sitemap에 있다(발견 누락 0). 상세 og 파싱도 정상 — `/p/jqi2g7na` → "뮤직피디아" / "음악계의 왓챠피디아, 뮤직피디아" / `https://music-pedia.vercel.app`로 이 문서의 샘플과 완전히 일치한다. 비용만 신규 1건당 상세 요청 1회(하루 2~3회)로 늘었다.
>
> **RSC 엘리먼트 트리를 파싱해 A 경로를 되살리려 하지 말 것.** JSX 구조·className·자식 순서에 의존하게 되어 다음 개편에 다시 깨진다. sitemap + og 경로는 안정적인 공개 계약이다.

## 일일 물량

중앙값 2건/일, 평균 2.8건/일. 2026-05-21(사이트 첫 제품) ~ 2026-07-29 사이 sitemap의 /p/ URL 총 170건 / 활동일 61일 기준. 최근 7일(KST) 실측: 07-23=4, 07-24=5, 07-25=3, 07-26=3, 07-27=2, 07-28=4, 07-29=3(집계 시점 12:44 KST 기준 진행중). 최소 1건/일, 최대 16건/일(스파이크 있음). → 하루 1회 수집 시 신규 0~6건이 정상, 10건 넘으면 스파이크이거나 이전 런 실패 후 밀린 것.

## 요청

모든 요청 공통 헤더:
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
  Accept-Language: ko-KR,ko;q=0.9,en;q=0.8
쿠키/토큰/로그인 불필요. 페이지네이션 없음. robots.txt는 `/`와 `/p/`를 Allow(=/api/, /r/ 만 Disallow)하므로 아래 3개 경로 모두 허용 범위.

[R1] 필수 · 1회 — GET https://jocohunt.com/
     Accept: text/html,application/xhtml+xml
     실측: 200, 319,786 bytes, HTML(Next.js SSR). 최신 제품의 전체 메타데이터(name/tagline/slug/launchedAtMs) 포함.

[R2] 필수 · 1회 — GET https://jocohunt.com/sitemap.xml
     Accept: application/xml,text/xml
     실측: 200, 109,661 bytes, <url> 854개 중 /p/ 형태 170개. lastmod 내림차순 정렬. **lastmod 값이 launchedAtMs와 밀리초까지 정확히 일치**(예: /p/jqi2g7na lastmod=2026-07-29T02:16:31.753Z, launchedAtMs=1785291391753 → 동일). 전체 히스토리 보유 = 발견(discovery)의 정본.

[R3] 조건부 · 신규 slug 1건당 1회, 런당 최대 10회로 캡 — GET https://jocohunt.com/p/{slug}
     Accept: text/html,application/xhtml+xml
     R2에서 새로 발견됐는데 R1의 products 배열에는 없는 slug에 대해서만 호출(정상적인 날엔 보통 0~2회). externalUrl을 채우고 싶을 때도 사용.
     실측: GET /p/jqi2g7na → 200, 254,260 bytes / GET /p/uoeiqrt2 → 200, 263,178 bytes.

요청 간 300ms 정도 sleep. 타임아웃 15초, 실패 시 1회만 재시도.

절대 호출하지 말 것: https://jocohunt.com/products (클라이언트 fetch라 HTML에 데이터 0건이고 robots.txt가 /api/를 Disallow하므로 그 뒤의 API도 건드리지 않는다).

## 파싱 절차

━━ A. 홈(R1)에서 최신 제품 메타데이터 뽑기 ━━

A1. 응답을 **UTF-8**로 읽는다(한글 title/tagline. Node fetch면 res.text()가 알아서 처리, curl 파이프 쓸 거면 latin1 금지).

A2. Next.js flight payload 조각을 전부 모은다. HTML 전체에 대해 아래 정규식을 g 플래그로 반복 실행:
      /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g
    실측 매치 수 = 73개.

A3. 각 매치의 캡처그룹 m[1]을 **JS 문자열 리터럴로 정확히 디코딩**해 순서대로 이어붙인다:
      flight += JSON.parse('"' + m[1] + '"')
    ⚠ `html.replace(/\\"/g,'"')` 같은 전역 치환으로 때우지 말 것 — \u한글이스케이프·\n·\\ 가 깨진다. JSON.parse가 \" \\ \n \uXXXX 를 한 번에 정확히 처리한다.
    ⚠ 조각별로 파싱하지 말고 **반드시 전부 이어붙인 뒤** 다음 단계로. 하나의 JSON 토큰이 조각 경계에서 잘려 있다.
    실측: 이어붙인 flight 길이 = 144,002자.

A4. flight 안에서 리터럴 `"products":[` 의 인덱스 i 를 찾는다(실측 i=80888, 홈에서 정확히 1회 등장). 여러 번 나오면 A6의 검증(slug+launchedAtMs 동시 보유)을 통과하는 첫 배열을 쓴다.

A5. arrStart = i + '"products":'.length (= i+11). arrStart 위치의 `[` 부터 **문자열 인식 괄호 밸런싱**으로 짝 맞는 `]`까지 잘라낸다. 문자열 안(`"` 로 열린 구간)의 `[` `]` 는 세지 말고, `\` 이스케이프를 존중할 것:
      let d=0, inStr=false, esc=false;
      for (let k=arrStart; k<flight.length; k++) {
        const c = flight[k];
        if (inStr) { if (esc) esc=false; else if (c==='\\') esc=true; else if (c==='"') inStr=false; continue; }
        if (c==='"') inStr=true;
        else if (c==='[') d++;
        else if (c===']') { if (--d===0) { raw = flight.slice(arrStart, k+1); break; } }
      }
    ⚠ flight 전체를 JSON.parse 하려 들지 말 것 — RSC 페이로드라 `$L30` 같은 센티널과 `3:[...]` 줄번호 접두어가 섞여 있어 유효한 JSON이 아니다. 이 배열만 오려내면 순수 JSON이다.

A6. products = JSON.parse(raw). 실측 7건. 각 원소의 실제 키:
      id(uuid), slug, name, tagline, logoUrl, makerId, makerHandle, makerName,
      makerAvatarUrl, categorySlug, categoryLabel, upvotes, commentCount, launchedAtMs, voted
    (참고: 이 배열 직후에 `"title":"방금 올라온 프로덕트","viewAllHref":"/products?sort=recent","moreCount":0,"visibleCount":8` 가 붙어 있다. 컴포넌트명 RankedProductList.)

━━ B. sitemap(R2)에서 전체 slug + 정확한 런칭시각 뽑기 ━━

B1. `<url>` 블록 단위로 자른다: xml.match(/<url>[\s\S]*?<\/url>/g)  (실측 854개)
B2. 각 블록에서 아래 두 개를 뽑고, loc이 /p/ 패턴이 아니면 버린다(블로그·프로필·카테고리 URL이 대부분):
      slug   ← /<loc>\s*https:\/\/jocohunt\.com\/p\/([A-Za-z0-9_-]+)\s*<\/loc>/
      lastmod← /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/
    실측: /p/ 170개, slug 중복 0개, lastmod 완전 내림차순 정렬됨, 가장 오래된 값 2026-05-21T12:36:35.227Z.
B3. sitemapMap = Map<slug, lastmod(ISO)>.

━━ C. 합치기 ━━

C1. 후보 slug 집합 = sitemapMap의 키 중 이미 저장된 id(`jocohunt:{slug}`)에 없는 것. (아카이브가 비어 있는 최초 실행이면 최근 30일치만 취하거나 전체 170건을 백필하거나 선택 — 둘 다 안전. publishedAt이 정확해서 백필해도 순서가 맞는다.)
C2. 후보 slug가 A6의 products에 있으면 → name/tagline을 거기서 가져온다 (추가 요청 0회).
C3. 후보 slug가 products에 없으면 → R3로 /p/{slug}를 받아 og 메타에서 가져온다:
      title       ← /<meta property="og:title" content="([^"]*)"/           (실측 /p/uoeiqrt2 → "탱탱볼 샷")
      description ← /<meta property="og:description" content="([^"]*)"/     (실측 → "튕기고, 조준하고, 맞혀라! 손맛 짜릿한 탱탱볼 슈팅 게임")
    뽑은 값은 HTML 속성 이스케이프를 되돌린다: &amp;→& &lt;→< &gt;→> &quot;→" &#39;→'
C4. (선택) externalUrl 채우기 — R3 HTML에 A2·A3와 **동일한** flight 디코딩을 적용한 뒤:
      /"href":"(https?:\/\/[^"]+)","event":"product_website_click"/
    실측: /p/jqi2g7na → https://music-pedia.vercel.app , /p/uoeiqrt2 → https://play.google.com/store/apps/details?id=com.tangtang.shot&pcampaignid=web_share
    매치가 여러 번 나온다(데스크톱/모바일 버튼 중복) — 첫 매치만 쓴다. 없으면 externalUrl 생략.
C5. publishedAt은 **sitemapMap의 lastmod를 우선** 사용(이미 ISO8601, launchedAtMs와 밀리초까지 동일). sitemap에 없고 홈에만 있으면 new Date(launchedAtMs).toISOString().
C6. publishedAt 오름차순으로 정렬해 emit(같은 collectedAt 안에서 아카이브 순서가 자연스러워짐).

## 필드 매핑

id          = "jocohunt:" + slug
              예: "jocohunt:jqi2g7na"
              ⚠ 반드시 **slug**를 쓸 것. 응답의 `id` 필드(uuid, 예 d8ec97a6-30c8-44ed-8d04-f7c813348765)를 쓰면 안 된다 — sitemap 경로에는 uuid가 없어서 홈 경로와 fallback 경로가 서로 다른 id를 만들어 중복 저장된다. slug는 URL(/p/{slug})과 sitemap 양쪽에 다 있어서 어느 경로로 들어와도 동일한 id가 나온다.
              slug 형태(실측): 소문자+숫자 8자, 예 jqi2g7na, qlus2pwc, 5mllyuch, o3mvo9wy. 검증 정규식은 여유 있게 /^[A-Za-z0-9_-]{4,32}$/.

source      = "jocohunt"  (하드코딩 상수)

title       = products[].name          (홈 경로)
            | og:title 값              (fallback 경로 — /p/ 페이지의 og:title은 name과 정확히 일치. <title>은 " · 조코헌트" 접미사가 붙으니 og:title을 우선)
            trim만 하고 그 외 가공 금지.

description = products[].tagline       (홈 경로)
            | og:description 값        (fallback 경로 — tagline과 일치)
            null/undefined/공백이면 "" (빈 문자열). 자르거나 요약하지 말 것.

url         = "https://jocohunt.com/p/" + slug
              항상 이 형태로 조립. 실측 og:url과 일치("https://jocohunt.com/p/jqi2g7na").

externalUrl = C4에서 뽑은 product_website_click href. 못 뽑으면 **키 자체를 생략**(빈 문자열 넣지 말 것).
              값이 jocohunt.com 내부 도메인이면 버린다.

publishedAt = sitemap의 <lastmod> 문자열 그대로(이미 "2026-07-29T02:16:31.753Z" 형태의 ISO8601 UTC).
              sitemap에 없으면 new Date(launchedAtMs).toISOString().
              두 값은 실측상 완전히 동일하므로 어느 쪽이든 무방. 표시용이며 정렬 기준 아님.

collectedAt = 컬렉터가 이 아이템을 **처음** 본 시각. new Date().toISOString().
              이미 아카이브에 있는 id면 기존 collectedAt을 절대 덮어쓰지 않는다.

버리는 필드: logoUrl, makerId, makerHandle, makerName, makerAvatarUrl, categorySlug, categoryLabel, upvotes, commentCount, voted, uuid id.
             (가공 없음 원칙 + 스키마에 자리가 없음. upvotes/commentCount는 시간에 따라 변하므로 저장하면 diff가 매일 더러워진다.)

## 실제 샘플

{
  "id": "jocohunt:jqi2g7na",
  "source": "jocohunt",
  "title": "뮤직피디아",
  "description": "음악계의 왓챠피디아, 뮤직피디아",
  "url": "https://jocohunt.com/p/jqi2g7na",
  "externalUrl": "https://music-pedia.vercel.app",
  "publishedAt": "2026-07-29T02:16:31.753Z",
  "collectedAt": "2026-07-29T03:44:41.922Z"
}

(전부 방금 실제 응답에서 나온 값이다. 출처: GET / 의 flight products[6] = {"id":"d8ec97a6-30c8-44ed-8d04-f7c813348765","slug":"jqi2g7na","name":"뮤직피디아","tagline":"음악계의 왓챠피디아, 뮤직피디아","categorySlug":"web-apps","upvotes":0,"launchedAtMs":1785291391753} / GET /sitemap.xml 의 <loc>https://jocohunt.com/p/jqi2g7na</loc><lastmod>2026-07-29T02:16:31.753Z</lastmod> / GET /p/jqi2g7na 의 product_website_click href. collectedAt만 실행 시각.)

같은 런에서 나온 나머지 6건(요약, 검증용):
  jocohunt:qlus2pwc "서치튠"                    publishedAt 2026-07-29T00:50:55.673Z
  jocohunt:5mllyuch "트루하운드 데팟(Truthound Depot)" / "데이터 버전 관리와 스키마 검증을 위한 관리형 콘솔" 2026-07-28T23:56:15.319Z
  jocohunt:mesel7et "마냑"                      2026-07-28T07:40:47.098Z
  jocohunt:ou9jqkdg "Reeca AI" / "이력서를 분석하고, 자소서 초안과 역량검사 준비까지 도와주는 서비스" 2026-07-28T07:11:50.458Z
  jocohunt:o3mvo9wy "GenioPlus" / "캐릭터 그림 한 장이면 끝나는 2D 게임 애니메이션 스프라이트 시트 생성" 2026-07-28T04:59:21.937Z
  jocohunt:ieqs31vu "Wallpets® : 월펫" / "데스크탑에 살아 숨쉬는 당신만의 반려동물" 2026-07-28T04:10:45.443Z
fallback 경로 실증(홈에 없던 slug): jocohunt:uoeiqrt2 "탱탱볼 샷" / "튕기고, 조준하고, 맞혀라! 손맛 짜릿한 탱탱볼 슈팅 게임" / externalUrl "https://play.google.com/store/apps/details?id=com.tangtang.shot&pcampaignid=web_share" / publishedAt 2026-07-27T08:55:45.378Z

## healthCheck

아래를 순서대로 단언한다. 하나라도 깨지면 이 소스를 실패로 표시하고(다른 소스는 계속 진행) 로그에 어느 단언이 깨졌는지 남긴다. **부분 성공을 조용히 0건으로 삼키지 말 것.**

[HTTP]
H1. R1, R2 모두 status === 200.
H2. R1 body.length > 100_000 (실측 319,786). R2 body.length > 30_000 (실측 109,661).

[sitemap — 이게 살아 있으면 최소한의 수집은 가능]
H3. /p/ URL 개수 >= 100  (실측 170, 단조 증가만 함. 100 미만이면 sitemap 형식이 바뀐 것)
H4. 모든 lastmod가 Date.parse 가능하고 NaN 아님.
H5. lastmod 최신값이 now - 14일 보다 최근. (14일간 신규 0건이면 사이트가 죽었거나 sitemap이 정지한 것 → 경고)
H6. slug 중복 0개. (실측 0)

[홈 flight — 이게 깨지면 fallback으로 전환]
H7. self.__next_f.push 매치 개수 >= 10 (실측 73).
H8. 이어붙인 flight 길이 > 50_000 (실측 144,002).
H9. flight.includes('"products":[') === true.
H10. 괄호 밸런싱으로 오려낸 raw에 대해 JSON.parse가 예외 없이 성공.
H11. ~~products.length >= 1 (실측 7).~~ **2026-07-30 폐기.** 빈 배열이 사이트의 정상 상태가 됐다(문서 상단 참조). 배열이 아니면 여전히 실패지만, 비어 있으면 빈 Map을 반환하고 F1로 진행한다. "조용히 0건"은 H15가 잡으므로 안전망이 사라지지 않는다.
H12. products의 **모든** 원소가: typeof slug === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(slug) && typeof name === 'string' && name.trim() !== '' && Number.isInteger(launchedAtMs) && launchedAtMs > 1_700_000_000_000 && launchedAtMs < Date.now() + 86_400_000.
H13. 교차검증: products의 모든 slug가 sitemapMap에 존재해야 한다. 하나라도 없으면 파싱 오염 의심 → 실패.
H14. 교차검증: 임의의 한 건에 대해 new Date(launchedAtMs).toISOString() === sitemapMap.get(slug). (실측 7/7 일치. 불일치하면 launchedAtMs 의미가 바뀐 것)

[신규 0건이 정상인지 아닌지 구분 — 가장 중요]
H15. 신규 0건은 **sitemapMap의 최신 lastmod에 해당하는 slug가 이미 아카이브에 있을 때만** 정상이다.
     if (newItems.length === 0 && !archive.has('jocohunt:' + newestSitemapSlug)) → 실패(파서가 죽었는데 조용히 0건 반환하는 상황).
H16. 반대로 신규 건수 > 25 면 실패 대신 경고 + 25건에서 잘라 저장(sitemap 형식이 바뀌어 전량이 신규로 보이는 사고 방지).

[아이템 최종 검증 — emit 직전]
H17. 각 아이템: id가 /^jocohunt:[A-Za-z0-9_-]{4,32}$/, url이 `https://jocohunt.com/p/` + id.split(':')[1] 와 정확히 일치, title.trim() !== '', typeof description === 'string', publishedAt이 유효 ISO8601.
H18. title/description에 리터럴 `\u` 나 `\"` 문자열이 남아 있으면 실패(A3 디코딩을 안 한 것). 정규식: /\\u[0-9a-fA-F]{4}|\\"/ 로 검사.
H19. title에 깨진 한글(`ì` `ë` `í` 연속)이 있으면 실패(UTF-8 미적용).

## 폴백

계층형으로 3단계. 위가 깨져도 아래가 살아 있으면 수집은 계속된다.

F1. **(2026-07-30부터 상시 경로다.)** 홈 products가 비었거나 flight 파싱이 깨졌을 때 → **sitemap 단독 모드**
    sitemap의 /p/ 목록(전체 히스토리 + 정확한 lastmod)에서 미수집 slug를 골라, 각각 GET /p/{slug}를 호출하고 og:title / og:description 으로 title/description을 채운다. publishedAt은 lastmod 그대로.
    런당 detail 호출 상한 10건(하루 평균 2.8건이라 충분). 상한 초과분은 lastmod 최신순으로 자르고 나머지는 다음 런에 잡힌다.
    → 이 경로만으로도 스키마의 모든 필수 필드가 채워진다. 실증 완료: /p/uoeiqrt2 → title "탱탱볼 샷", description "튕기고, 조준하고, 맞혀라! 손맛 짜릿한 탱탱볼 슈팅 게임".

F2. detail 페이지의 og 메타까지 사라졌을 때 → **최소 아이템 모드**
    title  = <title> 텍스트에서 접미사 " · 조코헌트" 를 제거한 값 (실측 "<title>뮤직피디아 · 조코헌트</title>" → "뮤직피디아").
             정규식: /<title>([\s\S]*?)<\/title>/ 후 .replace(/\s*·\s*조코헌트\s*$/,'').trim()
    description = "" (스키마상 허용)
    externalUrl 생략. url/publishedAt은 sitemap에서 이미 확보.
    → 제목+링크+날짜만이라도 아카이브에 남는다.

F3. sitemap.xml 까지 200이 아닐 때 → **홈 단독 모드**
    A 경로만으로 products 7건 정도를 수집. publishedAt은 launchedAtMs 변환값 사용. 하루 1회 실행 + 홈 윈도우가 대략 이틀치라 이 모드로도 당분간 손실 없음.

F4. R1·R2 둘 다 실패 → 이 소스만 0건 + 실패 표시로 종료. 다른 소스 수집과 커밋은 정상 진행. 3일 연속 F4면 사람이 봐야 한다는 신호(README나 커밋 메시지에 남길 것).

없음에 해당하는 경우는 없다 — sitemap과 홈 두 축이 서로 독립적으로 동작한다.

## 함정

1. **홈 목록은 전체가 아니다.** 홈의 products 배열 제목은 "방금 올라온 프로덕트"이고, 실측 7건은 정확히 KST 07-28(4건) + KST 07-29(3건) = 오늘+어제 KST 분량이다. KST 07-27에 런칭된 uoeiqrt2, 7qx26chu 두 건은 sitemap에는 있는데 홈에는 **없다**. 게다가 옆에 visibleCount:8 이 붙어 있어 상한선 의혹도 있다(관측 최대 16건/일). → 홈만 믿고 수집하면 스파이크 날에 유실된다. **발견은 sitemap, 메타데이터는 홈** 이 원칙을 지킬 것.

2. **48시간 롤링 윈도우가 아니다.** 수집 시각 2026-07-29T03:44Z 기준 48h 이전은 07-27T03:44Z인데, 07-27T08:55Z의 uoeiqrt2가 홈에서 빠져 있다. KST 날짜 경계 기반으로 보인다. 즉 KST 자정 직후에 돌리면 홈 윈도우가 방금 갈린 상태일 수 있다. 06:00 KST 스케줄이면 안전하지만, 어차피 sitemap이 커버하므로 신경 쓸 필요 없다.

3. **flight 조각을 개별로 파싱하지 말 것.** self.__next_f.push([1,"..."])는 실측 73조각이고, JSON 토큰이 조각 경계에서 잘려 있다. 전부 디코딩·연결한 뒤에 `"products":[` 를 찾아야 한다.

4. **이스케이프는 정확히 1단계다.** 원본 HTML에는 `\"products\":[` 처럼 `\"` 형태로 들어 있다. `JSON.parse('"' + captured + '"')` 로 풀어야 한다. `replace(/\\"/g,'"')` 전역 치환으로 때우면 `\\`(리터럴 백슬래시)와 `\uXXXX`가 오염된다. H18이 이 실수를 잡는다.

5. **flight 전체를 JSON.parse 할 수 없다.** RSC 페이로드라 `3:[...]` 같은 줄번호 접두어와 `"$L30"`, `"$"` 센티널이 섞여 있다. 반드시 products 배열만 괄호 밸런싱으로 오려낼 것. 밸런서는 문자열 안의 대괄호를 세면 안 되고(className에 `lg:grid-cols-[1fr_280px]`, `shadow-[0_4px_16px_-4px_var(--accent-glow)]` 같은 Tailwind 값이 대괄호 범벅이다) `\` 이스케이프도 존중해야 한다. 이거 안 하면 100% 잘못 잘린다.

6. **id에 uuid를 쓰면 중복 저장된다.** 응답의 `id` 필드는 uuid인데 sitemap에는 uuid가 없다. 홈 경로와 fallback 경로가 서로 다른 id를 만들어 같은 제품이 두 번 들어간다. 반드시 slug 기반 `jocohunt:{slug}`.

7. **홈에는 externalUrl이 없다.** products 배열에 제품 웹사이트 URL이 아예 없다. 필요하면 /p/{slug}를 추가로 받아 `"href":"...","event":"product_website_click"` 에서 뽑아야 하고, 이 패턴은 데스크톱/모바일 버튼 때문에 페이지당 2회 이상 매치되므로 첫 매치만 쓴다. externalUrl은 스키마상 optional이니 비용이 아깝다면 아예 생략해도 된다(신규 2~5건 × 250KB/건 = 하루 1MB 남짓이라 켜도 부담은 없다).

8. **upvotes / commentCount는 저장 금지.** 매일 변한다. 저장하면 커밋 diff가 매일 무의미하게 커지고, "오늘 새로 들어온 것" 판정에도 쓸모없다. categorySlug/categoryLabel도 마찬가지로 스키마 밖 — 분류 금지 원칙에도 걸린다.

9. **UTF-8 필수.** title/tagline이 한글이고 `Wallpets® : 월펫`, `트루하운드 데팟(Truthound Depot)`, `® ·` 같은 특수문자·전각괄호가 실제로 들어온다. Node fetch의 res.text()는 안전. 셸 파이프라인 쓸 거면 인코딩 확인할 것.

10. **og:title/og:description은 HTML 속성 이스케이프 상태다.** `&amp;` `&#39;` 등이 나올 수 있으니 fallback 경로에서는 반드시 디코딩. 반면 홈 flight의 name/tagline은 이미 순수 문자열이라 디코딩하면 오히려 깨진다. 두 경로에 서로 다른 후처리를 적용할 것.

11. **sitemap은 lastmod 내림차순 정렬이지만 그걸 가정하지 말 것.** 실측은 완전 정렬이지만, diff는 "정렬 순서"가 아니라 "저장된 id 집합"과 비교해야 한다. 정렬 순서에 의존하면 사이트가 정렬을 바꾸는 날 조용히 망가진다.

12. **lastmod ≠ "수정 시각".** 이름은 lastmod지만 실제로는 launchedAtMs와 밀리초까지 동일한 런칭 시각이다(7/7 검증). 즉 제품이 나중에 수정돼도 이 값이 바뀌어 재수집을 유발할 가능성은 낮지만, 만약 바뀌더라도 우리 dedup은 id 기준이라 안전하다. publishedAt만 표시용으로 갱신될 뿐.

13. **최초 실행 백필이 쉽다.** sitemap에 2026-05-21부터 170건 전체가 정확한 시각과 함께 있으므로 원하면 한 번에 백필 가능. 단 detail 페이지 170회 호출은 과하니, 백필할 거면 title/description 없이 넣지 말고 F1의 10건/런 캡을 걸어 여러 날에 걸쳐 채우거나, 최근 30일치만 담는 편이 낫다.

14. **홈 HTML의 `/p/{slug}` 링크를 긁어서 발견에 쓰지 말 것.** 홈이 sitemap보다 앞설 것 같아 보이지만, 2026-07-30 실측에서 홈 flight의 `/p/` 링크 7개 중 1개(`k3xq9p2m`)가 **제품이 아니라 출시 폼의 i18n 예시 문자열**이었다: `"urlHint":"출시 후 URL은 자동 부여되는 8자 ID로 만들어집니다 (예: /p/k3xq9p2m)"`. `/p/k3xq9p2m`은 200을 주지만 og:title이 사이트 기본값("조코헌트 - 한국 빌더 커뮤니티")이라, 링크를 긁으면 그 제목의 쓰레기 항목이 아카이브에 들어간다. 발견은 sitemap만 쓴다. 나머지 6건은 전부 sitemap에 있어 손실도 없다.

15. **/products 는 절대 긁지 말 것.** 클라이언트 fetch라 HTML에 데이터가 0건이고, 그 뒤의 XHR 엔드포인트는 robots.txt에서 /api/ 로 Disallow되어 있다. sitemap이 같은 정보를 공개 경로로 다 준다.

16. **Sentry가 붙어 있다.** 페이지에 sentry-trace / baggage 메타가 있으므로 4xx를 유발하는 요청은 상대 로그를 더럽힌다. 재시도는 1회로 제한하고 존재하지 않는 slug를 추측해서 호출하지 말 것.
