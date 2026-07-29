# 일딴 (ilddan.com) (`ilddan`)

> 이 문서는 2026-07-29에 **실제 HTTP 응답을 받아** 작성된 수집 계약이다.
> 추측이 아니라 실측이며, `sampleItem`은 그날 받은 진짜 데이터다.
> 사이트가 바뀌면 이 문서를 먼저 고치고 코드를 고친다.

## 일일 물량

실측(2026-07-29 03:43 UTC 기준): cat=web 노출 12건이 2026-07-14 ~ 2026-07-28(14일)에 분포 → 약 0.9건/일. cat=game 노출 11건이 2026-07-03 ~ 2026-07-29(26일)에 분포 → 약 0.4건/일. 합계 하루 1~2건. 서버가 알려주는 카테고리 전체 누적은 web total=36, game total=11 (단 노출은 카테고리당 최신 12건까지만). 하루 1회 수집이면 12건 창 = web 기준 약 13일치 버퍼라 충분히 안전.

## 요청

요청 2회. 페이지네이션 없음(아래 gotchas 참조). 인증/쿠키 불필요.

  GET https://ilddan.com/market?cat=web     # 웹·앱·SaaS
  GET https://ilddan.com/market?cat=game    # 게임

필수 헤더 (브라우저 UA로 검증함. Node/curl 기본 UA는 검증하지 않았으므로 그대로 쓸 것):
  user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36
  accept: text/html

실측 응답: HTTP 200, content-type "text/html; charset=utf-8", 본문 web≈74.6KB / game≈59.6KB.
두 요청은 순차로 보내고 사이에 1~2초 딜레이를 두면 충분히 예의 있음.

Node 예시:
  const res = await fetch(`https://ilddan.com/market?cat=${cat}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`ilddan ${cat}: HTTP ${res.status}`);
  const html = await res.text();

/market (cat 파라미터 없음)은 스킬·가이드·템플릿이 섞이므로 절대 쓰지 말 것. cat=etc 탭도 존재하지만 완성 제품이 아니므로 제외. web + game 두 개만 수집한다.

## 파싱 절차

Next.js App Router의 RSC flight 페이로드 안에 React Query dehydrated state가 들어 있다. 아래 절차를 카테고리별 HTML마다 수행한다.

1. 응답 본문을 UTF-8 문자열 `html`로 읽는다.

2. RSC flight 청크를 전부 이어붙인다. HTML 안에서 페이로드는 JS 문자열 리터럴로 한 단계 이스케이프되어 있다(원본 바이트에 `\"mutations\":[]` 형태로 존재).
   정규식(전역):
     /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g
   각 매치의 캡처그룹 1(양쪽 따옴표 포함)을 `JSON.parse()`로 언이스케이프한 뒤 등장 순서대로 concat 한다.
     let m, flight = '';
     while ((m = re.exec(html)) !== null) flight += JSON.parse(m[1]);
   실측 청크 수: cat=web 14개(합쳐서 38,126자), cat=game 8개(29,990자).
   주의: 첫 인자가 `1`인 청크만 대상. `[0,...]` 등 다른 청크는 제외한다.

3. 이어붙인 `flight` 문자열에서 다음 리터럴의 **첫** 인덱스를 찾는다.
     const start = flight.indexOf('{"mutations":[],"queries":[');
   `start < 0`이면 파싱 실패로 처리한다(fallback으로 넘어감).
   실측 위치: web 27013, game 18633.

4. `start`부터 문자열-인식 중괄호 매칭으로 균형 잡힌 JSON 오브젝트를 잘라낸다. 문자열 리터럴 내부의 `{` `}` 는 세지 않고, `\` 다음 한 글자는 건너뛴다. depth가 0으로 돌아오는 `}` 의 인덱스+1까지가 끝.
     let depth = 0, inStr = false, esc = false, end = -1;
     for (let i = start; i < flight.length; i++) {
       const c = flight[i];
       if (esc) { esc = false; continue; }
       if (c === '\\') { esc = true; continue; }
       if (inStr) { if (c === '"') inStr = false; continue; }
       if (c === '"') { inStr = true; continue; }
       if (c === '{') depth++;
       else if (c === '}' && --depth === 0) { end = i + 1; break; }
     }
   실측 길이: web 10,031자, game 10,275자.

5. `JSON.parse(flight.slice(start, end))` → `state`. `state.queries` 배열에서
     q.queryKey[0] === 'market'
   인 항목을 찾는다. 실측 queries.length === 1이고
     queryKey = ["market", {"q":"","sort":"created_at","page":1,"per":12,"cat":"web"}]
   형태다. queryKey[1].cat 이 요청한 cat과 같은지 확인하면 더 안전하다.

6. `const rows = q.state.data.rows` — 배열. 실측 web 12건, game 11건. `q.state.data`의 최상위 키는 `rows`, `total`, `tagMap` 세 개다.
   - `total`은 그 카테고리의 전체 누적 건수(web=36, game=11)지만 `rows`는 **항상 최대 12건**이다. `total`을 페이지네이션 근거로 쓰지 말 것.
   - `rows`는 `created_at` 내림차순(최신순)으로 이미 정렬되어 있다(실측 확인).
   - `tagMap`은 productId → 태그 배열 맵이다. 우리는 쓰지 않는다(가공 금지 원칙상 태그도 저장 안 함).

7. row 객체의 실제 키는 정확히 다음 13개다:
     id, created_at, title, category, description, thumb_url, file_url,
     seller_name, owner_id, downloads, views, comment_count, popular

8. 각 row를 fieldMapping대로 공통 스키마로 변환한다. 변환 전 `row.id`가 UUID 정규식
     /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
   에 맞고 `row.title`이 비어있지 않은지 확인하고, 아니면 그 row는 건너뛴다.

9. web·game 두 카테고리 결과를 합치고 `id` 기준 Set으로 중복 제거한다(교차 중복은 실측상 없지만 방어적으로 유지). `collectedAt`은 실행 시작 시 한 번 계산한 값을 모든 아이템에 동일하게 넣는다.

## 필드 매핑

row → 공통 스키마

- id           = `ilddan:${row.id}`
                 row.id는 UUID v4 문자열. 영구 불변 키로 신뢰 가능.
                 예: "ilddan:b8278794-2785-4b2b-83ed-0858f9170e7b"

- source       = "ilddan"  (고정)

- title        = String(row.title).trim()
                 JSON 경로라 HTML 엔티티 이스케이프 없음. 그대로 사용.

- description  = typeof row.description === 'string'
                   ? row.description.replace(/\r\n/g, '\n').trim()
                   : ''
                 소스가 주는 건 "한줄설명"이 아니라 **본문 전문**이다. 자르거나 요약하지 말 것(가공 금지).
                 개행 정규화(\r\n → \n)와 trim만 허용. UI에서 line-clamp로 접어 보여준다.
                 없으면 "" (실측상 전 건 존재하지만 방어).

- url          = `https://ilddan.com/product/${row.id}`
                 소스 내 상세 페이지. HTTP 200 실측 확인.
                 항상 이 값을 메인 링크로 쓴다(외부 링크가 아니라).

- externalUrl  = row.file_url을 trim한 값이 /^https?:\/\//i 에 매치될 때**만** 세팅, 아니면 필드 자체를 생략.
                 실측 12건 중 1건이 "" (빈 문자열)이므로 반드시 가드할 것.

- publishedAt  = row.created_at 을 `new Date(row.created_at).toISOString()` 으로 정규화.
                 원본 포맷: "2026-07-28T07:02:10.988076+00:00" (마이크로초 6자리 + +00:00 오프셋).
                 JS Date가 파싱 가능하며 밀리초로 절삭된다 → "2026-07-28T07:02:10.988Z".
                 Date.parse 실패 시(NaN) 필드 생략. 표시용일 뿐 정렬에 쓰지 않는다.

- collectedAt  = 컬렉터 실행 시각 `new Date().toISOString()`.
                 배치 내 모든 아이템에 동일 값. "오늘 새로운 것" 정렬/판정의 유일한 기준.
                 이미 아카이브에 있는 id는 기존 collectedAt을 절대 덮어쓰지 않는다.

버리는 필드(저장하지 않음): category, thumb_url, seller_name, owner_id, downloads, views, comment_count, popular, 그리고 data.tagMap.
(카테고리를 소스 키에 섞지 않는다. source는 web/game 구분 없이 "ilddan" 하나다.)

## 실제 샘플

2026-07-29T03:43:35Z에 https://ilddan.com/market?cat=web 을 실제로 호출해 받은 rows[0]을 변환한 결과 (실데이터, 손대지 않음):

{
  "id": "ilddan:b8278794-2785-4b2b-83ed-0858f9170e7b",
  "source": "ilddan",
  "title": "같은 뉴스인데 AI 친구 둘의 설명이 다르다 — 대화형 뉴스 앱 요잇슈",
  "description": "조심스럽게 사이드프로젝트 하나 소개해봅니다!\n평소에 뉴스 봐야지 하면서도 양도 많고 어려워서 자꾸 미루게 되더라구요. 그래서 하루에 딱 1개 이슈만 골라서, AI 캐릭터 두 명이 카톡하듯 서로 다른 시선으로 얘기해주는\n'요잇슈'라는 웹 서비스를 만들었어요.\n설치 없이 웹에서 바로 써볼 수 있어요. 무료입니다!\n아직 부족한 부분이 많아서 써보시고 의견 남겨주시면 정말 큰 도움이 될 것 같아요 🙏\n\n  ✅ 요잇슈에서는\n\n  • 무한 피드 없이 하루에 뉴스 하나만 만나요\n  • 취향에 맞는 캐릭터 두 명을 고를 수 있어요\n  • 이해되지 않는 부분을 채팅으로 바로 물어볼 수 있어요\n  • 마음에 남은 뉴스와 내가 궁금했던 내용을 기록할 수 있어요\n  • 필요하면 원문 기사와 출처도 확인할 수 있어요\n\n  🙋 이런 분께 추천해요\n\n  • 뉴스는 알아야 할 것 같지만 너무 많아 지친 분\n  • 경제·정치 용어가 나오면 읽기를 포기하게 되는 분\n  • 한쪽 요약보다 여러 시선을 보고 싶은 분\n  • 혼자 읽는 것보다 대화하면서 이해하는 게 편한 분",
  "url": "https://ilddan.com/product/b8278794-2785-4b2b-83ed-0858f9170e7b",
  "externalUrl": "https://yoissue-web.vercel.app/",
  "publishedAt": "2026-07-28T07:02:10.988Z",
  "collectedAt": "2026-07-29T03:43:35.594Z"
}

같은 실행의 cat=game rows[0] (전체 통틀어 최신 항목, externalUrl이 도메인 루트라 슬래시 없는 케이스):

{
  "id": "ilddan:7a88060a-3eb9-4033-8956-17a5b66db6cf",
  "source": "ilddan",
  "title": "쇼츠처럼 넘겨보는 밸런스게임(VSVSVS)",
  "description": "https://vsvsvs.today\n\n안녕하세요 취미로 바이브코딩하는 사람입니다!\n\n이반에는 심심풀이로 하기 좋은 '숏폼 밸런스 게임' 웹사이트 하나 만들었습니다. 숏츠 넘기듯 스와이프하면서 밸런스 질문들에 투표하고 다른 사람들 반응도 볼 수 있어요. 댓글 기능도 있습니다.\n\n직접 기발한 밸런스 게임을 만들어서 올릴 수도 있습니다. 가입이나 앱 설치 없이 닉네임만 적으면 바로 가능하니 킬링타임용으로 심심하신 분들 한 번씩 해보세요!\n\nhttps://vsvsvs.today",
  "url": "https://ilddan.com/product/7a88060a-3eb9-4033-8956-17a5b66db6cf",
  "externalUrl": "https://vsvsvs.today",
  "publishedAt": "2026-07-29T02:09:13.007Z",
  "collectedAt": "2026-07-29T03:43:35.594Z"
}

(이 실행의 최종 산출은 web 12 + game 11 = 중복 제거 후 23건이었다.)

## healthCheck

카테고리별(HTML 1개당) 하드 단언 — 하나라도 false면 그 카테고리는 1차 파싱 실패로 보고 fallback으로 넘어간다.

  H1. res.ok === true 이고 res.status === 200
  H2. content-type 이 /text\/html/ 매치
  H3. html.length > 20000            (실측 web 74,591 / game 59,581 바이트)
  H4. flight 청크 정규식 매치 수 >= 1 (실측 web 14 / game 8)
  H5. flight.indexOf('{"mutations":[],"queries":[') >= 0
  H6. 중괄호 매칭이 end > start 로 닫힘 → JSON.parse 성공 (throw 안 함)
  H7. state.queries 가 배열이고, queryKey[0] === 'market' 인 항목이 정확히 1개 존재
  H8. q.state.data.rows 가 배열
  H9. rows.length >= 1
       추가 강한 단언: rows.length === Math.min(q.state.data.total, 12)
       (실측 web: min(36,12)=12 ✓ / game: min(11,12)=11 ✓)
       이게 깨지면 서버가 페이징을 도입했거나 per 기본값이 바뀐 것 → 경고 로그 남기고 계속 진행
 H10. rows[0].id 가 /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i 매치
 H11. typeof rows[0].title === 'string' && rows[0].title.trim().length > 0
 H12. Number.isNaN(Date.parse(rows[0].created_at)) === false
 H13. rows 전체에 'id','title','created_at','description','file_url' 키가 모두 존재
       (없는 키가 생기면 스키마 변경 신호 → 경고)

배치 전체 단언:

 H14. 두 카테고리 합산 유효 아이템 수 === 0  →  **실패로 간주하고 프로세스를 non-zero로 종료**하거나
      최소한 ilddan을 "broken" 상태로 기록한다. 조용히 0건을 커밋하지 말 것.
 H15. 합산 아이템 수 < 15  → 경고(실측 23). 파서가 부분적으로 깨졌을 가능성.
 H16. rows가 created_at 내림차순인지 확인: 인접 쌍이 모두 Date.parse(a) >= Date.parse(b).
      깨져도 치명적이지 않음(우리는 collectedAt으로 정렬) → 경고만.
 H17. 신선도: max(publishedAt)가 now - 30일보다 오래되면 경고.
      하루 1~2건 나오는 사이트라 30일간 신규 0건이면 "사이트가 죽었거나 파서가 옛 캐시를 읽는 중"이다.
 H18. 회귀 감지: 직전 실행 대비 신규 id가 14일 연속 0건이면 경고.
      (12건 창이 약 13일치이므로 그보다 길게 신규가 없으면 비정상)

정상 판정 요약 한 줄: "cat=web과 cat=game 각각에서 queryKey[0]==='market'인 dehydrated query를 찾았고, rows가 각각 1건 이상이며 rows[0].id가 UUID이고 rows[0].title이 비어있지 않다."

## 폴백

1차: flight 페이로드의 dehydrated JSON (위 parseSteps). description·publishedAt·externalUrl까지 전부 얻는 유일한 경로.

2차 (실측 검증 완료): 서버가 렌더한 HTML 카드 마크업을 정규식으로 긁는다. 클래스명 `pcard` / `ptitle` 기준.

  const re = /<a class="pcard" href="\/product\/([0-9a-f-]{36})">[\s\S]*?<span class="ptitle">([\s\S]*?)<\/span>/g;
  const cards = [...html.matchAll(re)].map(m => ({
    id: m[1],
    title: m[2].replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '').trim(),
  }));

  검증 결과: cat=web 12건, cat=game 11건 정상 추출. 첫 건 title
  "같은 뉴스인데 AI 친구 둘의 설명이 다르다 — 대화형 뉴스 앱 요잇슈" 로 1차 경로와 완전 일치.
  ※ 이 경로에서는 반드시 HTML 엔티티 디코딩(&amp; &lt; &gt; &#39; &quot;)을 거칠 것. 현재 표본엔 엔티티가 없지만 제목에 & 가 들어오면 바로 문제가 된다.

  2차로 얻는 필드: id, title, url(=https://ilddan.com/product/{id}) 만.
  채우는 방법: description = "", publishedAt 생략, externalUrl 생략, collectedAt은 평소대로.
  → 핵심 기능(신규 감지 = 중복제거 키, 열어볼 링크, 아카이브 검색용 제목)은 전부 살아있다.

3차 (선택): 2차로 얻은 **신규 id에 한해** 개별 상세 페이지를 요청해 description/created_at/file_url을 보강한다.
  GET https://ilddan.com/product/{id}   (HTTP 200, 약 61KB 실측 확인)
  하루 신규가 1~2건이라 요청 부담이 사실상 없다. 상세 페이지도 같은 Next.js flight 구조이므로 2~5단계 파서를 그대로 재사용하되, queryKey[0]이 'market'이 아닐 수 있으니 키 매칭 조건을 완화하고 `id`가 해당 UUID인 오브젝트를 찾는 식으로 접근할 것.

4차 fail-soft: 1·2차 모두 0건이면 **아무것도 커밋하지 말고 ilddan만 실패로 기록**한다. 기존 아카이브 JSON은 그대로 두고(절대 덮어쓰기/삭제 금지), 다른 소스 수집은 계속 진행한다. Actions job은 warning으로 끝내되 로그에 "ilddan: 0 items, both parsers failed"를 남겨 눈에 띄게 한다.

## 함정

파싱 함정
- **이스케이프 한 겹**: flight 페이로드는 HTML 안에서 JS 문자열 리터럴로 이스케이프되어 있다. 원본 바이트는 `\"mutations\":[]` 다. 따라서 raw HTML에 대고 `"mutations":[]` 를 grep하면 **0건**이 나온다(실제로 확인했다). 반드시 각 청크 문자열을 `JSON.parse()`로 한 번 언이스케이프한 뒤에 찾을 것. 반대로 두 번 언이스케이프하면 깨진다 — 딱 한 겹이다.
- **청크 경계**: 페이로드가 여러 `self.__next_f.push([1,"..."])` 청크로 쪼개져 있고(web 14개) 목표 JSON이 청크 경계를 가로지를 수 있다. 청크별로 따로 찾지 말고 **전부 concat한 뒤에** 검색할 것.
- **중괄호 매칭은 문자열 인식 필수**: description 안에 `{`, `}`, `\"`, 이모지가 그대로 들어있다. 단순 카운팅으로 자르면 엉뚱한 데서 끊긴다.
- `state.queries`는 현재 1개지만 배열이다. `queries[0]`로 하드코딩하지 말고 `queryKey[0] === 'market'`로 찾을 것.

페이지네이션 (중요)
- **page / per 파라미터를 서버가 무시한다.** `?cat=web&page=2&per=50` 으로 요청해도 queryKey가 여전히 `{page:1, per:12}`이고 rows 12건의 id 배열이 page 미지정 요청과 **완전히 동일**했다(실측 대조 확인). 즉 백필·과거 조회 불가, 항상 "최신 12건 창"만 본다.
- 그래서 `data.total`(web=36)을 보고 "36건 다 가져올 수 있다"고 착각하지 말 것. 26건은 영원히 안 보인다.
- 결과적으로 **워크플로가 13일 이상 멈추면 그 사이 올라온 web 항목은 영구 유실**된다(web ≈0.9건/일 × 12건 창 ≈ 13일 버퍼). cron 실패 알림을 켜두는 게 좋다.

카테고리
- `/market`(cat 없음)은 스킬·가이드·템플릿이 섞이므로 쓰지 말 것. `cat=web`(웹,앱,SaaS)과 `cat=game` 두 개만이 완성 제품이다. `cat=etc` 탭도 존재하지만 완성 제품이 아니다.
- 카테고리를 source 키에 섞지 말 것 — source는 `"ilddan"` 하나. 두 요청 결과를 합쳐 id로 dedupe한다.

description
- **한줄설명이 아니라 본문 전문**이다. 수백~천 자 이상, `\r\n` 개행, 이모지(🙏 ✅ 🙋), 평문 불릿(`•`)이 섞여 있다. 저장은 원문 그대로(개행 정규화·trim만), 자르기·요약은 UI의 line-clamp로 처리한다.
- description이 URL 한 줄로 시작하는 경우가 흔하다(VSVSVS는 첫 줄과 끝 줄이 `https://vsvsvs.today`). 자동 링크 변환하지 말고 텍스트로 렌더할 것.

file_url / externalUrl
- **제품 사이트가 아닐 수 있다.** 실측 표본에 다음이 전부 섞여 있었다:
  · `""` 빈 문자열 (web 12건 중 1건) → externalUrl 생략해야 함
  · Supabase Storage 직링크 `.mov` (데모 **영상 파일**, 사이트 아님)
  · Supabase Storage 직링크 `.html` (게임 파일 그 자체 — 이건 진짜 제품)
  · Google Play 스토어 링크 (`?pcampaignid=web_ilddan` 트래킹 파라미터 붙어옴)
  · GitHub releases 태그 링크
- 따라서 **메인 링크는 항상 `url`(ilddan 상세 페이지)** 로 쓰고 externalUrl은 보조로만 노출. 폰에서 `.mov` 링크를 무심코 누르면 파일 다운로드가 걸린다.
- Supabase 프로젝트 호스트(`wxvpujynikmbcabhcsiy.supabase.co`)가 externalUrl에 그대로 노출된다. 저장해도 무방하지만 인지해 둘 것.

날짜
- `created_at` = `"2026-07-28T07:02:10.988076+00:00"` — 마이크로초 **6자리** + `+00:00` 오프셋. JS Date가 파싱은 하지만 밀리초로 절삭된다. `toISOString()`으로 정규화해서 저장할 것. 원본 문자열끼리 사전식 비교는 되지만 정규화 후 비교를 권장.
- publishedAt은 신뢰하지 않는다(표시용). "오늘 새로운 것"은 반드시 collectedAt 기준. 기존 id의 collectedAt은 절대 덮어쓰지 말 것.

fallback HTML 경로
- 렌더 마크업 안에 React의 `<!-- -->` 텍스트 구분자 주석이 들어간다(`pcc`, `pdl` span 내부). 현재 `ptitle` 안에는 없지만 파서는 주석·태그 제거 후 trim 하도록 방어할 것.
- HTML 엔티티 디코딩 필수(1차 JSON 경로에서는 불필요).
- `pcard` / `ptitle` 클래스명은 언제든 바뀔 수 있다. 이건 진짜 최후 수단이다.

기타
- **2026년 7월 개설된 신생 사이트**다. Vercel 호스팅(스크립트 URL에 `?dpl=dpl_...` 배포 해시가 붙는다 — 배포마다 바뀌므로 절대 하드코딩 금지). 스키마·클래스명·라우팅이 예고 없이 바뀔 수 있으니 healthCheck를 느슨하게 두지 말 것.
- `__NEXT_DATA__`는 존재하지 않는다(App Router). Pages Router 방식 파서를 쓰면 안 된다.
- 요청은 하루 2회면 충분. 쿠키·인증·리퍼러 불필요. UTF-8 고정.
- 검증에 쓴 참조 구현(그대로 TS로 옮기면 됨): `/private/tmp/claude-501/-Users-joel-Desktop-idea/393d446c-462e-43e0-84a9-13495a24d375/scratchpad/collector.mjs` — 실제 라이브 요청으로 23건 산출까지 확인했다(세션 스크래치패드라 휘발성이니 필요하면 지금 복사할 것).
