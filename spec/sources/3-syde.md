# SYDE 쇼케이스 (`syde`)

> 이 문서는 2026-07-29에 **실제 HTTP 응답을 받아** 작성된 수집 계약이다.
> 추측이 아니라 실측이며, `sampleItem`은 그날 받은 진짜 데이터다.
> 사이트가 바뀌면 이 문서를 먼저 고치고 코드를 고친다.

## 일일 물량

평균 2건/일. 실측(2026-07-29 03:40 UTC 호출): 최근 24시간 created_at 기준 3건, 최근 7일 15건(=2.1건/일), 전체 누적 count=148. 리스트 1회 응답에 항상 20건이 오므로 하루 1회 수집이면 신규분을 놓칠 여유가 매우 크다(20건 창 ≒ 10일치).

## 요청

GET https://syde.kr/showcase

필수 헤더:
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
  Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
  Accept-Language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7

페이지 수: 1회만. 페이지네이션 하지 말 것.
- ?page=2 는 서버에서 무시됨(실측 확인). ?page=2 응답도 currentPage:1, 동일한 20건 slug 배열이 그대로 반환됨. 페이징 시도는 낭비이고 중복만 만든다.
- 응답: HTTP 200, text/html; charset=utf-8, 약 336KB, Vercel(Next.js App Router SSR), cache-control: no-store 라 캐시 신경 안 써도 됨.

선택적 2차 요청(externalUrl 을 채우고 싶을 때만):
GET https://syde.kr/showcase/{encodeURIComponent(slug)}  — 같은 헤더 사용.
신규로 판정된 아이템에 대해서만 호출(하루 1~3회). 요청 간 300~500ms 간격 권장. 실패해도 아이템은 externalUrl 없이 저장하고 전체 수집은 성공 처리할 것.

## 파싱 절차

1. HTML 본문 전체를 문자열로 받는다(res.text()).

2. RSC flight 청크를 모두 정규식으로 뽑아 순서대로 이어붙인다. 반드시 아래 정규식을 그대로 쓸 것(문자열 리터럴을 정확히 매칭하며 /s 플래그 불필요):
   const RE = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
   let m, flight = "";
   while ((m = RE.exec(html)) !== null) flight += JSON.parse(m[1]);
   - 캡처그룹 m[1] 은 JS 문자열 리터럴(따옴표 포함)이다. JSON.parse 로 언이스케이프하면 평문 JSON 조각이 나온다. 언이스케이프는 이 1회면 충분하다(2중 언이스케이프 하지 말 것).
   - `[1,` 형태만 매칭한다. `push([0])` 같은 다른 형태는 데이터가 없다.
   - 실측: 18개 청크, 이어붙인 flight 길이 123,629자.

3. 컨테이너 키의 시작 위치를 찾는다:
   const KEY = '"initialShowcases":';
   const i = flight.indexOf(KEY);
   i === -1 이면 실패로 간주(healthCheck 참조).

4. i + KEY.length 위치부터 **중괄호 균형 슬라이서**로 객체 문자열을 잘라낸다. 정규식으로 자르면 안 된다(사유는 gotchas 참조). 아래 함수를 그대로 쓸 것 — 문자열 리터럴 안의 괄호와 백슬래시 이스케이프를 건너뛴다:

   function sliceBalanced(s, start) {
     let depth = 0, inStr = false, esc = false;
     for (let k = start; k < s.length; k++) {
       const c = s[k];
       if (inStr) {
         if (esc) esc = false;
         else if (c === '\\') esc = true;
         else if (c === '"') inStr = false;
         continue;
       }
       if (c === '"') inStr = true;
       else if (c === '{' || c === '[') depth++;
       else if (c === '}' || c === ']') { depth--; if (depth === 0) return s.slice(start, k + 1); }
     }
     return null;
   }

5. JSON.parse 한다.
   const container = JSON.parse(sliceBalanced(flight, i + KEY.length));
   실측 최상위 키: { showcases, count, mentionedProfiles, currentPage }
   - container.showcases : 아이템 배열 (실측 길이 20, 항상 20으로 보임)
   - container.count     : 전체 누적 개수 (실측 148) — 페이지네이션용이 아니라 총계 표시용
   - container.currentPage : 실측 항상 1

6. const rows = container.showcases; — 이 배열이 아이템 소스다. 각 원소를 fieldMapping 대로 공통 스키마로 변환한다.

7. 정렬/필터: rows 는 bumped_at 내림차순이다(created_at 순서 아님, 실측 확인). 우리 쪽에서는 정렬에 의존하지 말고 **전체 20건을 모두 변환한 뒤 id 로 기존 아카이브와 대조해 신규만 추가**한다. created_at 으로 자체 필터링(예: "어제 이후만") 하지 말 것 — 표시용일 뿐 신뢰하지 않는다는 원칙과 collectedAt 기준 정렬 원칙에 맞춰, 신규 판정은 오직 id 중복제거로 한다.

8. (선택) externalUrl 채우기: 7단계에서 신규로 판정된 아이템에 대해서만 상세 페이지를 GET 하고, 2~4단계와 동일한 방식으로 flight 를 이어붙인 뒤 `"showcase":` 키를 찾아 sliceBalanced 로 객체를 파싱한다. 상세 객체에는 web_url / playstore_url / appstore_url 필드가 있다(리스트에는 없음). 우선순위 web_url → appstore_url → playstore_url 로 첫 번째 non-null 값을 쓰고, 스킴이 없으면 "https://" 를 앞에 붙인다.

## 필드 매핑

리스트 아이템(row) → 공통 스키마:

  id          = "syde:" + row.id
                row.id 는 uuid v4(실측 20/20 전부 uuid 형식). 영구 불변이며 bump 되어도 바뀌지 않으므로 중복제거 키로 안전하다.
                slug 로 id 를 만들지 말 것 — slug 는 작성자가 수정 가능하고 한글이라 불안정하다.

  source      = "syde"  (상수)

  title       = row.name
                원본 그대로. 실측 예: "인플레이스: inFlace", "하루 요정 : AI 생성형 다이어리". 콜론/공백 정리 금지.

  description = row.short_description ?? ""
                한 줄 설명이 여기 들어있다. 실측 20건 전부 비어있지 않았지만 방어적으로 ?? "" 처리.
                주의: row.description 은 쓰지 말 것 — 본문 전체가 담긴 거대한 TipTap 문서 JSON 객체({type:"doc",content:[...]})다. 한 줄 설명이 아니다.

  url         = "https://syde.kr/showcase/" + encodeURIComponent(row.slug)
                encodeURIComponent 필수(한글 슬러그). 실측: slug "인플레이스" → .../showcase/%EC%9D%B8%ED%94%8C%EB%A0%88%EC%9D%B4%EC%8A%A4 로 HTTP 200 확인.
                이미 인코딩된 값이 아니므로 이중 인코딩 걱정은 없다. slug 를 그대로 붙이지 말 것.

  externalUrl = 리스트에서는 **채울 수 없다. 필드를 생략(undefined)한다.**
                브리핑의 external_link 필드는 현재 응답에 존재하지 않는다(빈 값이 아니라 키 자체가 없음 — 리스트 20건 키 합집합에 없고 상세 페이지에도 없음).
                상세 페이지를 추가로 부를 때만 web_url / playstore_url / appstore_url 에서 채운다(parseSteps 8단계).

  publishedAt = new Date(row.created_at).toISOString()
                row.created_at 원문은 "2026-07-29T01:20:47.60077+00:00" (마이크로초 + "+00:00" 오프셋). new Date() 가 정상 파싱하며 밀리초로 절삭된다.
                bumped_at 을 쓰지 말 것 — 오래된 항목이 재노출된 시각이라 발행일이 아니다.

  collectedAt = 수집 실행 시각. 아이템별로 새로 만들지 말고 **런 시작 시점에 한 번 계산한 값을 그 런의 모든 신규 아이템에 동일하게 부여**한다(new Date().toISOString()). "오늘 새로운 것" 정렬이 이 필드 기준이므로 같은 런의 항목들이 같은 값을 갖는 게 맞다.
                기존 아카이브에 이미 있는 id 는 collectedAt 을 절대 덮어쓰지 않는다(최초로 본 시각 보존).

버려도 되는 필드(저장하지 않음): description(TipTap), thumbnail_url, updated_at, bumped_at, bump_count, user_id, views_count, showcase_awards, profiles, showcase_comments, upvotes_count, upvotesCount, hasUpvoted, members, showcase_upvotes.

## 실제 샘플

{
  "id": "syde:8fa13138-70dd-4074-b8df-b70b383b5871",
  "source": "syde",
  "title": "File Blossom",
  "description": "안전한 암호화 파일 공유 도구 사이트",
  "url": "https://syde.kr/showcase/file-blossom",
  "publishedAt": "2026-07-29T01:20:47.600Z",
  "collectedAt": "2026-07-29T03:42:39.554Z"
}

(2026-07-29 03:40 UTC 실제 호출로 받은 리스트의 첫 번째 항목을 변환한 것. 원본 row: id "8fa13138-70dd-4074-b8df-b70b383b5871", name "File Blossom", slug "file-blossom", short_description "안전한 암호화 파일 공유 도구 사이트", created_at "2026-07-29T01:20:47.60077+00:00", bumped_at 동일, views_count 14. externalUrl 은 리스트에 소스 필드가 없어 생략됨.)

한글 슬러그 실측 예시(상세 요청으로 web_url 까지 채운 경우):
{
  "id": "syde:...",
  "source": "syde",
  "title": "인플레이스: inFlace",
  "description": "...",
  "url": "https://syde.kr/showcase/%EC%9D%B8%ED%94%8C%EB%A0%88%EC%9D%B4%EC%8A%A4",
  "externalUrl": "https://www.inflace.site/?utm_source=syde&utm_medium=community&utm_campaign=launch",
  "publishedAt": "2026-07-28T13:58:14.029Z",
  "collectedAt": "2026-07-29T03:42:39.554Z"
}
(상세 페이지 web_url 원문은 스킴 없는 "www.inflace.site/?utm_source=syde&..." 였고 "https://" 를 붙여 정규화한 값이다.)

## healthCheck

아래가 **전부 참**이면 정상. 하나라도 거짓이면 이 소스를 실패로 표기하고(다른 소스 수집은 계속) 아카이브를 덮어쓰지 않는다.

1. HTTP 상태가 200 이다.
2. 본문 길이 > 50000 (실측 336,270). 이보다 훨씬 작으면 챌린지/에러 페이지다.
3. flight 청크 정규식 매칭 개수 >= 1 (실측 18). 0이면 __next_f 형식이 바뀐 것.
4. flight.indexOf('"initialShowcases":') !== -1.
5. sliceBalanced 결과가 null 이 아니고 JSON.parse 가 예외 없이 성공한다.
6. Array.isArray(container.showcases) && container.showcases.length >= 10 (실측 20). **0건이면 무조건 실패로 간주** — 정상 상태에서 리스트가 비는 경우는 없다.
7. typeof container.count === "number" && container.count > 0 (실측 148).
8. 모든 아이템이 다음을 만족:
   - /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)   (실측 20/20 통과)
   - typeof row.name === "string" && row.name.trim().length > 0
   - typeof row.slug === "string" && row.slug.length > 0                                (실측 20/20 통과)
   - !isNaN(new Date(row.created_at).getTime())                                          (실측 20/20 통과)
9. 최근 30일 이내 created_at 인 아이템이 1건 이상 존재한다. (실측 최근 7일 15건. 하루 1~2건 올라오는 사이트이므로 30일간 0건이면 파싱이 과거 데이터에 고착됐거나 사이트가 죽은 것.)
10. 변환된 id 배열에 중복이 없다: new Set(ids).size === ids.length.

경고(실패는 아니지만 로그에 남길 것):
- showcases.length !== 20 → 페이지 크기 변경 신호.
- 신규 판정 건수가 0건인 날이 3일 연속 → 하루 1~2건 소스이므로 사실상 고장 의심.
- 신규 판정 건수가 한 번에 15건 이상 → 아카이브 유실 후 재수집이거나 id 규칙 변경 의심. 커밋 전에 사람이 확인.

## 폴백

1차(권장) 대체 — `"initialShowcases":` 키 이름만 바뀐 경우:
이어붙인 flight 문자열 전체를 스캔해 쇼케이스 객체를 직접 긁는다. 키 이름에 의존하지 않는다.
  const START = /\{"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}","name":"/g;
  let m; const rows = [];
  while ((m = START.exec(flight)) !== null) {
    const s = sliceBalanced(flight, m.index);
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o.slug && o.name && o.created_at) rows.push(o);
    } catch {}
    START.lastIndex = m.index + 1;   // 중첩 객체까지 훑도록
  }
  // id 로 중복 제거 후 사용
그 다음은 동일한 fieldMapping 을 적용한다. 이 경로로 얻은 rows.length 가 5 미만이면 실패 처리.
(주의: profiles/members 안의 중첩 객체도 "id"+"name" 패턴에 걸릴 수 있으므로 반드시 slug && created_at 존재 여부로 걸러낼 것.)

2차 대체 — flight 형식 자체가 사라진 경우(App Router 이탈 등):
SSR 된 HTML 마크업에서 상세 링크를 긁는다.
  const A = /href="\/showcase\/([^"?#]+)"/g;
  → slug 를 decodeURIComponent 로 복원, 중복 제거, 내비게이션성 경로(빈 값, "new", "edit" 등) 제외.
  각 slug 마다 상세 페이지를 1회 GET 해서 uuid(id)·name·short_description·created_at 을 확보한 뒤 정상 매핑한다.
  ★ 반드시 상세 페이지에서 uuid 를 얻어 id 를 만들 것. slug 로 id 를 합성하면("syde:slug:...") 기존 아카이브의 uuid 기반 id 와 충돌하지 않아 전 항목이 신규로 재유입된다(중복 폭발). uuid 를 못 얻으면 그 항목은 버린다.
  요청 수가 늘어나므로 상위 20건까지만, 요청 간 500ms 간격.

3차 — 위가 모두 실패하면:
externalUrl 채우기용 상세 요청 실패는 무시하고 진행하되, 리스트 파싱 자체가 실패하면 **빈 배열을 반환해 아카이브를 건드리지 않고** 해당 런을 실패로 기록한다. 부분 데이터로 기존 JSON 을 덮어쓰지 말 것.

대체 피드 없음: SYDE 는 RSS/Atom/공개 JSON 엔드포인트를 제공하지 않는다. 공개 HTML 응답 파싱이 유일한 경로다.

## 함정

1. **external_link 필드는 존재하지 않는다.** 브리핑에는 "리스트에선 빈 경우 있음"이라 되어 있으나, 실측 결과 리스트 20건의 키 합집합에도, 상세 페이지 객체에도 external_link 라는 키가 아예 없다. 상세 페이지에만 web_url / playstore_url / appstore_url 세 필드가 있다. 리스트만 파싱하면 externalUrl 은 항상 undefined 다. 이걸 모르고 row.external_link 를 읽으면 조용히 undefined 가 되어 버그를 놓친다.

2. **web_url 에 스킴이 없다.** 실측값 "www.inflace.site/?utm_source=syde&utm_medium=community&utm_campaign=launch". 그대로 href 에 넣으면 상대경로로 해석돼 syde.kr 내부 링크가 된다. /^https?:\/\//i 로 검사해 없으면 "https://" 를 붙일 것. 또한 소스가 붙여둔 utm_* 파라미터가 그대로 들어있다 — 가공 금지 원칙에 따라 제거하지 말고 그대로 저장한다.

3. **정렬 기준이 bumped_at 이다(실측 확인).** 리스트는 bumped_at 내림차순이며 created_at 내림차순이 아니다. 예: created_at 2026-05-14 인 "릴티(Liltie)" 가 bumped_at 2026-07-22 로 17번째에, created_at 2026-07-10 인 "Sidedock" 이 bumped_at 2026-07-28 로 3번째에 올라와 있다. 결과적으로 **두 달 전에 만들어진 항목이 오늘 리스트 상단에 나타날 수 있다.** id 중복제거를 하지 않고 "상단 N개 = 오늘의 신규" 로 처리하면 옛날 항목이 오늘 신규로 잘못 들어온다. 반대로 bump 된 항목은 id 가 같으므로 중복제거만 제대로 하면 재유입되지 않는다 — collectedAt 도 최초값을 유지해야 한다.

4. **?page=2 는 무시된다(실측 확인).** 응답이 200 이라 성공처럼 보이지만 currentPage 는 1이고 20건 slug 배열이 1페이지와 완전히 동일하다. 페이지 루프를 돌리면 같은 데이터를 반복 파싱하게 된다. 절대 페이징하지 말 것. count(148)는 총계일 뿐 페이지 수 계산에 쓸 수 없다.

5. **`"initialShowcases":` 값을 정규식으로 잘라내면 반드시 깨진다.** row.description 이 사용자가 쓴 본문 전체를 담은 TipTap 문서 JSON 이라 중괄호와 이스케이프된 따옴표가 잔뜩 들어있다. /"initialShowcases":(\{.*?\})/ 같은 lazy 매칭은 실제로 JSON.parse 에서 실패함을 확인했다. greedy 매칭도 뒤쪽 다른 객체까지 삼켜 실패한다. 문자열/이스케이프를 인지하는 중괄호 균형 슬라이서를 써야 한다.

6. **청크 경계를 반드시 먼저 이어붙여라.** self.__next_f.push 청크는 대부분 4096바이트로 잘려 있다(실측 청크 크기: 4096,4096,4096,1976,4921,...,78943). 이번 응답에서는 initialShowcases 가 우연히 마지막 청크(78,943자) 안에 통째로 들어갔지만 이는 보장되지 않는다. 개별 청크를 하나씩 검사하는 코드는 어느 날 갑자기 실패한다. 전부 concat 한 뒤에 indexOf 할 것.

7. **언이스케이프는 정확히 1회.** HTML 안에서는 `\"initialShowcases\":{\"showcases\":[...` 처럼 보이지만, 이는 청크가 JS 문자열 리터럴이기 때문이다. m[1] 을 JSON.parse 하면 평문 JSON 이 된다. 여기서 또 replace(/\\"/g,'"') 같은 2차 언이스케이프를 하면 본문에 포함된 정상적인 백슬래시가 망가진다.

8. **한글 슬러그 인코딩 필수.** 실측 20건 중 16건이 한글 slug 다("인플레이스", "포커스빌드-찐친과-함께하는-공부-타이머", "지구미아-세일정보-지금이야" 등). encodeURIComponent 없이 URL 을 만들면 폰 브라우저나 JSON 소비 단계에서 깨진다. 반대로 이미 인코딩된 값을 다시 인코딩하지 않도록, 저장은 인코딩된 형태로 딱 한 번만 한다.

9. **title 에 콜론/공백이 섞여 있다.** "인플레이스: inFlace", "하루 요정 : AI 생성형 다이어리", "어디살까." 등. 가공 금지 원칙대로 trim 이상은 하지 말 것. 특히 콜론 앞뒤를 파싱해 이름/부제로 나누려는 유혹을 피할 것.

10. **created_at 정밀도가 들쭉날쭉하다.** "2026-07-29T01:20:47.60077+00:00"(5자리), "2026-07-27T10:22:31.01788+00:00" 처럼 마이크로초 자릿수가 6자리가 아닐 수 있고 오프셋이 "Z" 가 아니라 "+00:00" 이다. new Date() 는 정상 파싱하지만 문자열 비교로 정렬하면 자릿수 차이 때문에 틀릴 수 있다. 반드시 Date 로 변환 후 비교할 것.

11. **cache-control: no-store 이고 x-vercel-cache: MISS 였다.** 매번 fresh 응답이므로 조건부 요청(If-Modified-Since/ETag)은 기대하지 말 것. 하루 1회 호출이라 문제없다.

12. **브라우저 User-Agent 필수.** Vercel 앞단이 기본 curl/node UA 를 다르게 취급할 수 있다. GitHub Actions 러너에서도 위 UA 를 그대로 보낼 것.

13. **하루 1~2건 소스라 "신규 0건"이 정상일 수 있다.** 0건을 즉시 오류로 처리하면 오탐이 난다. 다만 리스트 자체가 0건인 것은 무조건 오류다(healthCheck 6번). 이 둘을 구분할 것.
