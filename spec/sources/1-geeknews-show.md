# GeekNews Show (`geeknews-show`)

> 이 문서는 2026-07-29에 **실제 HTTP 응답을 받아** 작성된 수집 계약이다.
> 추측이 아니라 실측이며, `sampleItem`은 그날 받은 진짜 데이터다.
> 사이트가 바뀌면 이 문서를 먼저 고치고 코드를 고친다.

## 일일 물량

실측 ~5–12건/일. datetime 히스토그램(2026-07-29 실행, /show 1~2페이지 40건): 07-27 12건, 07-28 9건, 07-26 4건, 07-25 3건, 07-24 1건 (07-29는 정오 기준 2건). 평균 ~7건/일이며 과제에 적힌 "~5건"보다 많다. 하루 HTTP 요청 총량 = 목록 2회 + 신규 상세 ~7회 ≈ 9회.

## 요청

【중요: 과제에 주어진 전제 2개가 실측 결과 틀렸다. Atom 피드를 쓰면 안 된다. 근거는 gotchas 1·2 참조.】

공통 헤더 (모든 요청):
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36
  Accept: text/html,application/xhtml+xml
  Accept-Language: ko-KR,ko;q=0.9
타임아웃 10s, 실패 시 1회 재시도(2s 백오프), 요청 간 300ms 대기.

STEP A — 목록 (항상 2회, 고정):
  GET https://news.hada.io/show?page=1
  GET https://news.hada.io/show?page=2
  → 각 200 / Content-Type: text/html; charset=UTF-8 / 약 40KB / 페이지당 정확히 20행.
  → 2페이지면 실측상 최소 ~40시간치를 덮는다(page1 최고참 2026-07-28T01:05, page2 최신 2026-07-27T16:31). 하루 1회 cron에 충분.
  → 최초 시딩 때만 ?page=3 까지 추가로 받아도 된다. 평상시엔 2페이지 고정.

STEP B — 상세 보강 (아카이브에 없는 신규 id에 대해서만, 하루 ~7회):
  GET https://news.hada.io/topic?id=<id>
  → 200 / text/html / 35~48KB.
  → 이 요청은 필수다. 목록의 제목이 잘려 있고(86자+"..."), 외부 원문 URL이 목록에는 도메인만 있고 전체 URL이 없기 때문. 아래 "설계 결정 재검토" 참조.
  → best-effort: 실패하면 그 아이템은 목록 데이터만으로 저장하고 계속 진행(런 전체를 죽이지 않는다).

【설계 결정 재검토 — 결론: "추가 요청 없음"은 기각, "url = topic 페이지"는 유지】
- url = https://news.hada.io/topic?id=N 로 두는 것은 타당하다. 실측 확인: topic 페이지는 <link rel="canonical">가 자기 자신이고, 원문 링크 + 본문 전문 + 댓글이 모두 있다. 유지.
- 그러나 "추가 요청 안 함"은 유지 불가하다. 실측 근거:
  · 목록(/show)과 피드(/rss/news) 둘 다 제목을 86자에서 자르고 "..."를 붙인다.
    id=31902 목록 제목(89자): "Show GN: react-native-pure-chart 2.0.0 - SVG/Skia 없이 View만으로 차트 그리는 라이브러리, 9년 만에 AI 에이..."
    id=31902 상세 <h1> 전문(122자): "Show GN: react-native-pure-chart 2.0.0 - SVG/Skia 없이 View만으로 차트 그리는 라이브러리, 9년 만에 AI 에이전트로 부활 시킨 이야기"
    "가공 없음 / 원본 제목 저장" 원칙상 잘린 제목을 영구 저장하는 건 원칙 위반에 가깝다.
  · 외부 URL은 목록에 도메인만 있다(<span class=topicurl>(apps.apple.com)</span>). 전체 URL은 상세 페이지에만 있다(https://apps.apple.com/kr/app/id6790465525).
  · 비용: 하루 ~7회. 무시 가능. 게다가 STEP A가 이미 HTML 스크래핑이라 상세 페이지 스크래핑이 취약성 등급을 새로 올리지 않는다(정규식 모양도 거의 동일).

## 파싱 절차

【STEP A: /show HTML 1·2페이지 파싱】

1. 두 페이지 본문을 UTF-8 문자열로 이어붙이지 말고 각각 파싱한 뒤 결과 배열을 concat 한다.

2. 행 블록 분리 (페이지당 20개가 나와야 함):
   const ROW = /<div class='topic_row' data-topic-state-id='(\d+)'([\s\S]*?)(?=<div class='topic_row' data-topic-state-id=|<div class='next commentTD'>)/g;
   for (const m of html.matchAll(ROW)) { const nativeId = m[1]; const block = m[2]; ... }
   → nativeId 는 숫자 문자열(예: "31924"). 이게 네이티브 ID다.
   ※ lookahead에 종료 앵커 <div class='next commentTD'> 를 반드시 넣어야 마지막 20번째 행이 푸터까지 먹지 않는다.

3. 블록 안에서 필드 추출 (모두 block 대상):
   title_raw   = /<h2 class='topic-title-heading'>([\s\S]*?)<\/h2>/.exec(block)?.[1]
   desc_raw    = /<div class='topicdesc'><a [^>]*>([\s\S]*?)<\/a><\/div>/.exec(block)?.[1]
   published   = /datetime="([^"]+)"/.exec(block)?.[1]        // 예: "2026-07-29T08:06:33+09:00"
   domain      = /<span class=topicurl>\(([^)]*)\)<\/span>/.exec(block)?.[1]   // 예: "apps.apple.com" (참고용, 저장 안 함)
   points      = /<span id='tp\d+'>(\d+)<\/span>/.exec(block)?.[1]            // 저장 안 함, 무시
   ※ 실측 40/40 행 전부 title/desc/datetime/domain 모두 존재했다.

4. 텍스트 정규화 함수(제목·설명 공통, LLM 아님 · 순수 문자열 처리):
   const clean = s => decodeHtmlEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
   decodeHtmlEntities 는 &quot; &amp; &lt; &gt; &#039; &nbsp; 최소 6종 처리(실측 &quot; 등장 확인). 잘림 표시 " ..." / "…" 는 원본 그대로 남긴다.
   title = clean(title_raw);  description = clean(desc_raw);

5. 중복 제거: 같은 nativeId 가 1·2페이지에 동시에 나올 수 있으므로 Map<nativeId, row> 로 합친다(실측 이번엔 겹침 0이었지만 랭킹 재계산 중 발생 가능).

6. 필터: /show 페이지는 Show 전용 섹션이라 별도 제목 필터가 필요 없다(실측 40/40 전부 "Show GN"으로 시작). 절대 "Show GN:" prefix 필터를 걸지 마라 — 나중에 접두사가 바뀌면 조용히 0건이 된다. 대신 healthCheck 4번에서 비율만 감시한다.

【STEP B: /topic?id=N 상세 파싱 — 기존 아카이브에 없는 id만】

7. 상세 HTML에서 한 번에 두 개를 뽑는다:
   const DETAIL = /<div class='topictitle(?: link)?'>[\s\S]*?<a href='([^']+)' class='bold ud'><h1>([\s\S]*?)<\/h1>/;
   const d = DETAIL.exec(detailHtml);
   fullTitle   = d ? clean(d[2]) : null;
   externalRaw = d ? d[1] : null;

8. 외부 링크가 없는 자체 텍스트 글 대비(실측 40/40에는 없었지만 방어):
   위 정규식이 실패하면 제목만 따로 시도: /<div class='topictitle[^']*'>[\s\S]*?<h1>([\s\S]*?)<\/h1>/
   externalRaw = null 로 두고 진행.

9. externalUrl 채택 조건: /^https?:\/\//.test(externalRaw) 이고 new URL(externalRaw).hostname !== 'news.hada.io' 일 때만 채택. 아니면 필드 자체를 생략(undefined).

10. title 최종 결정: fullTitle 이 있으면 fullTitle 사용(전문). 없으면 STEP A의 잘린 title 사용.
    ※ 이미 아카이브에 있는 id는 STEP B를 건너뛰므로 제목이 갱신되지 않는다 — 최초 수집 시점에 확정된다. 의도된 동작.

## 필드 매핑

id          = `geeknews-show:${nativeId}`
              nativeId = /show 행의 data-topic-state-id 속성값(숫자 문자열).
              GeekNews topic id는 단조 증가하고 재사용되지 않으므로 영구 dedupe 키로 안전.
              예: "geeknews-show:31924"

source      = "geeknews-show" (고정 리터럴)

title       = STEP B의 상세 <h1> 전문(clean 적용). 상세 요청 실패 시에만 STEP A의 <h2 class='topic-title-heading'> 값(86자에서 잘림).
              "Show GN: " 접두사는 원본이므로 절대 제거하지 않는다(가공 없음 원칙).

description = STEP A의 <div class='topicdesc'> 안 <a> 텍스트에 clean 적용.
              사이트가 스스로 만든 발췌문이고 이미 " ..." 로 끝난다 — 재가공/재절단 금지.
              누락 시 폴백: 상세 페이지의 <meta name="description" content="..."> 값(clean 적용).
              둘 다 없으면 "" (스키마상 빈 문자열 허용).

url         = `https://news.hada.io/topic?${'id'}=${nativeId}`  → 실제로는 `https://news.hada.io/topic?id=${nativeId}`
              상세 페이지의 <link rel="canonical"> 와 정확히 일치함을 실측 확인(id=31924, 31902).
              목록의 href='topic?id=31937' 은 선행 슬래시 없는 상대경로이므로 그대로 쓰지 말고 위 문자열을 조립한다.

externalUrl = STEP B에서 뽑은 <div class='topictitle link'> 안쪽 <a href='...' class='bold ud'> 의 href.
              parseSteps 9번 조건을 통과할 때만 넣고, 아니면 필드 생략(스키마상 optional).

publishedAt = STEP A의 <time ... datetime="2026-07-29T08:06:33+09:00"> 속성값을
              new Date(v).toISOString() 로 UTC 정규화 → "2026-07-28T23:06:33.000Z"
              (같은 <time>에 data-timestamp="1785202868" 유닉스초도 있음. 동등하므로 아무거나. 절대 innerText 쓰지 말 것 — gotchas 5.)

collectedAt = 컬렉터가 그 아이템을 처음 본 시각. new Date().toISOString().
              기존 아카이브에 id가 있으면 기존 collectedAt 을 절대 덮어쓰지 않는다("오늘 새로운 것" 정렬의 기준이므로).

저장 안 하는 것: points(<span id='tp...'>), 작성자(<a href='/@user'>), 댓글 수(data-topic-comment-count), 도메인 표시(topicurl). 필요하면 나중에 추가.

## 실제 샘플

{
  "id": "geeknews-show:31924",
  "source": "geeknews-show",
  "title": "Show GN: DevClip – 클립보드 매니저를 24일간 클로드코드로 만들어 출시하기까지",
  "description": "복사한 것들이 하나씩 쌓이고 나중에 골라 쓰는 macOS 클립보드 매니저입니다. 수익화를 염두에 두고 만들었습니다. 첫날 이미 가격 이야기가 나왔...",
  "url": "https://news.hada.io/topic?id=31924",
  "externalUrl": "https://apps.apple.com/kr/app/id6790465525",
  "publishedAt": "2026-07-28T23:06:33.000Z",
  "collectedAt": "2026-07-29T03:45:12.983Z"
}

【출처 원본 (2026-07-29T03:45Z 실제 응답)】
- /show?page=1 행: data-topic-state-id='31924', <h2 class='topic-title-heading'>Show GN: DevClip – 클립보드 매니저를 24일간 클로드코드로 만들어 출시하기까지</h2>, <span class=topicurl>(apps.apple.com)</span>, <time ... datetime="2026-07-29T08:06:33+09:00" data-timestamp="1785202868">
- /topic?id=31924: <div class='topictitle link'>...<a href='https://apps.apple.com/kr/app/id6790465525' class='bold ud'><h1>Show GN: DevClip – 클립보드 매니저를 24일간 클로드코드로 만들어 출시하기까지</h1></a>
  <link rel="canonical" href="https://news.hada.io/topic?id=31924" />
  (이 건은 제목이 51자라 목록과 상세가 동일. 잘림이 실제로 발생한 건은 id=31902.)

## healthCheck

런당 아래를 순서대로 단언. HARD = 예외 던지고 커밋 안 함(직전 JSON 보존). WARN = 로그만 남기고 진행.

HARD 1  두 목록 요청 모두 res.status === 200 이고 res.headers['content-type'] 에 'text/html' 포함.
HARD 2  각 페이지 body.length > 15000.  (실측 page1 40250, page2 40030 bytes)
HARD 3  ROW 정규식 매치 수: page1 >= 10 (실측 20). 10 미만이면 마크업 변경으로 간주.
HARD 4  파싱된 전체 행 중 title(비어있지 않음) + datetime(new Date(v) 가 Invalid Date 아님) 둘 다 성공한 비율 >= 0.9. (실측 40/40 = 1.0)
HARD 5  title 중 /^Show\s*GN/.test(t) 인 비율 >= 0.8. (실측 40/40 = 1.0)
        0.8 미만 = /show 가 다른 섹션을 렌더링하거나 블록 경계가 어긋난 것.
HARD 6  page1의 최신 publishedAt 이 now - 7일 보다 최근. (실측 최신 항목이 11분 전)
        7일보다 오래됐으면 랭킹 블록을 잘못 잡았거나 섹션이 죽은 것.
HARD 7  최종 아이템 배열의 모든 id 가 /^geeknews-show:\d+$/ 를 만족하고 배열 내 중복 0.
HARD 8  모든 url 이 /^https:\/\/news\.hada\.io\/topic\?id=\d+$/ 를 만족.

WARN 9  publishedAt 이 now - 72h 이내인 아이템이 1건 이상. (실측 하루 5~12건이라 정상이면 항상 참)
        0건이면 목록은 파싱됐지만 신규 유입이 끊긴 것 — 사람이 볼 신호.
WARN 10 STEP B를 시도한 신규 아이템 중 externalUrl 추출 성공 비율 >= 0.8. (실측 3/3 = 1.0)
        미만이면 상세 마크업 변경 의심. 보강만 끄고 목록 데이터로 저장은 계속.
WARN 11 STEP B에서 fullTitle 을 얻은 아이템 중, 목록 title 과 다른 건(=잘렸던 건)이 있으면 정상 동작 신호.
        신규 10건 이상인데 fullTitle 이 단 한 건도 안 뽑히면 상세 파싱이 통째로 깨진 것.
WARN 12 이번 런 신규 건수 > 40 이면 최초 시딩이거나 dedupe 실패. 최초 시딩(아카이브 비어있음)이 아니면 커밋 전에 확인.

## 폴백

1차: https://news.hada.io/show?page=1,2 (HTML) + /topic?id=N 상세 보강.

폴백 A — 상세 보강만 깨진 경우 (HARD 아님):
  STEP B 전체를 스킵하고 STEP A 데이터만으로 아이템 생성. title 은 86자에서 잘리고 externalUrl 은 없음. 아카이브는 계속 돌아간다. 이게 사실상 "과제에 원래 적혀 있던 설계"이며, 열화 모드로는 충분히 쓸 만하다.

폴백 B — /show HTML 구조가 바뀐 경우 (HARD 3/4/5 실패):
  https://news.hada.io/rss/news (Atom, 200, application/atom+xml) 로 전환.
  파싱: /<entry>([\s\S]*?)<\/entry>/g → 각 entry에서
        title: /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/
        id:    /<id>https:\/\/news\.hada\.io\/topic\?id=(\d+)<\/id>/
        published: /<published>([^<]+)<\/published>/
        content: /<content type='html' xml:lang='ko'><!\[CDATA\[([\s\S]*?)\]\]><\/content>/ → clean() 후 description
  필터: title.startsWith('Show GN')
  ★ 반드시 알 것: 이건 동등한 대체재가 아니다. 실측상 Show 글의 절반가량을 빠뜨린다(gotchas 1). 폴백 B로 떨어지면 WARN을 남겨 사람이 알아채게 하고, 임시 조치로만 쓴다. 폴백 B 상태로 며칠 이상 방치하면 아카이브에 구멍이 생긴다.

폴백 C — 둘 다 실패:
  이번 런은 0건으로 기록하고 종료. JSON 커밋하지 않음(기존 아카이브 그대로 유지). 전체 cron 잡을 실패시키지 말고 이 소스만 스킵 — 다른 소스 수집은 계속되어야 한다.

없음: 그 외 대체 경로 없음. /rss/show 는 404이고 공개 API는 없다.

## 함정

1. 【치명적 — 과제 전제가 틀림】 /rss/news 는 Show GN 글의 절반가량을 누락한다. 절대 1차 소스로 쓰지 마라.
   2026-07-29T03:40Z 실측: 피드 50엔트리의 topic id 범위 = 31878~31936. 같은 id 범위에 속하는 /show 상의 Show GN 글은 11건인데 피드에는 5건만 있었다.
   피드에 없는 것: 31881, 31889, 31903, 31914, 31915 (+ 범위 밖 최신 31937).
   포인트 임계값 때문도 아니다 — 1포인트짜리 31924는 피드에 있고, 똑같이 1포인트인 31915는 없다. 규칙 불명, 신뢰 불가.

2. 【과제 전제가 틀림 2】 제목이 잘린다. /show 목록과 /rss/news 둘 다 제목을 86자에서 자르고 "..."를 붙인다(총 89자).
   실측 id=31902 — 목록/피드: "...9년 만에 AI 에이..." (89자) vs 상세 <h1>: "...9년 만에 AI 에이전트로 부활 시킨 이야기" (122자).
   "원본 제목 저장" 요구를 지키려면 상세 페이지 요청이 필요하다.

3. 【정렬 순서】 /show 는 시간순이 아니라 HN식 랭킹(점수÷경과시간)이다. 실측 page1 1위=31937(2026-07-29, 1점), 2위=31904(2026-07-28), 그런데 17위=31313(2026-07-11, 106점).
   → "앞에서 N개 = 최신 N개" 가정 금지. 반드시 id로 dedupe하고 publishedAt/collectedAt으로 직접 정렬할 것.
   → 신규 글은 랭킹이 높게 들어오므로 page1에 반드시 나타난다. 그래도 하루 12건까지 나오는 날이 있으니 page 2까지 받는다.

4. 【최초 실행】 첫 런에서 40건이 한꺼번에 들어오고 전부 collectedAt 이 동일해진다. 그중엔 2026-07-06, 07-11 같은 3주 전 글도 섞여 있다(랭킹 상위 잔류). 정상이며 예상된 동작 — "오늘 새로운 것" 화면이 첫날만 40건이 된다. UI에서 놀라지 않도록 알아둘 것.

5. 【상대시간 함정】 <time> 요소의 텍스트는 "11분전", "22시간전", "1일전" 같은 한국어 상대시간이다. 절대 파싱하지 마라.
   반드시 속성을 써라: datetime="2026-07-28T14:36:15+09:00" 또는 data-timestamp="1785216975"(유닉스 초).

6. 【HTML 엔티티】 제목·설명에 &quot; &amp; &#039; 가 실제로 등장한다(실측 id=31902 설명에 &quot; 다수). 설명 안에 <br /> 도 들어간다. 반드시 태그 제거 + 엔티티 디코드.

7. 【따옴표 불일치】 GeekNews HTML은 속성 따옴표가 뒤죽박죽이다. 정규식을 눈대중으로 쓰면 안 된다.
   작은따옴표: class='topic_row', data-topic-state-id='31924', href='topic?id=31924', class='topicdesc', class='bold ud'
   큰따옴표:   class="topics", datetime="...", class="js-relative-time", <h2 class='topic-title-heading'>(← 이건 작은따옴표)
   따옴표 없음: <div class=votenum>, <span class=topicurl>, <div class=topicinfo>
   parseSteps에 적은 정규식은 실제 응답에 대해 40/40 성공을 검증한 것이다. 임의로 [\"'] 로 뭉개지 말고 그대로 써라.

8. 【상대 URL】 목록의 링크는 href='topic?id=31937' 로 선행 슬래시가 없다. new URL(href, 'https://news.hada.io/show') 로 풀거나, 권장대로 data-topic-state-id 에서 직접 조립하라.

9. 【외부 링크 없는 글 방어】 상세 페이지 컨테이너는 외부 링크가 있으면 class='topictitle link', 없으면 class='topictitle' 로 <a> 자체가 없을 수 있다. 실측 40/40 전부 외부 링크가 있었지만(topicurl 도메인 100% 존재) 크래시하지 않게 방어할 것. externalUrl 은 optional 필드다.

10. 【/rss/show 는 404】 시도하지 마라. 확인됨.

11. 【캐시】 CloudFront + nginx microcache. 응답 헤더 cache-control: max-age=60, s-maxage=300, x-microcache: HIT.
    갓 올라온 글이 최대 ~5분 늦게 보일 수 있다. 하루 1회 06:00 KST 실행에는 무관.
    실제로 이번 실측에서 31937(12:30:58 게시)이 /show 에는 있는데 피드에는 없었다 — 캐시가 아니라 gotchas 1의 누락 문제였다.

12. 【접두사 필터 금지】 /show 는 이미 Show 전용 섹션이므로 title.startsWith('Show GN') 필터를 걸 이유가 없다. 걸면 나중에 GeekNews가 접두사를 바꿨을 때 조용히 0건이 되고, "가공 없음" 원칙에도 어긋난다. 필터 대신 healthCheck 5번으로 비율만 감시.

13. 【제목 접두사 유지】 "Show GN: " 은 원본 제목의 일부다. 보기 좋게 하려고 벗겨내지 마라(가공 금지). 화면에서 숨기고 싶으면 표시 단계에서 CSS/JS로 처리.

14. 【description 재가공 금지】 목록 발췌문은 이미 사이트가 " ..." 로 끊어놓은 것이다. 그대로 저장. 문장 단위로 다시 자르거나 요약하지 마라.

15. 【collectedAt 불변】 이미 아카이브에 있는 id를 다시 만나면 collectedAt 을 갱신하면 안 된다. /show 가 랭킹순이라 3주 전 글이 매일 다시 보이는데, 갱신하면 매일 "오늘 새로운 것"에 재등장한다.

16. 【i18n 서브도메인 무시】 상세 페이지 <head>에 id.news.hada.io, vi.news.hada.io 등 hreflang 대체 링크가 있다. 항상 news.hada.io 만 쓴다.

17. 【검색 입력 길이】 사이트 검색은 maxlength=20 이지만 우리는 로컬 JSON을 검색하므로 무관. 참고만.

18. 【요청 예의】 상세 요청은 순차로, 300ms 간격으로. 하루 총 ~9회면 충분하다. 병렬 폭주 금지.
