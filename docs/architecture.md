# 아키텍처

시스템을 어떻게 나누고 연결하는지 다룬다. 기술 스택·버전과 구현·검증 규칙은 [docs/specs.md](specs.md)에서 관리한다. 저장소 구조와 데이터 모델의 정본은 [SPEC.md](../SPEC.md) 1~2절이며, 여기서는 진입점과 의존 방향만 정리한다.

## 구성 요소와 책임

서버·DB가 없다. 구성 요소는 세 덩어리이고, 그 사이를 Git 저장소의 JSON 파일이 잇는다.

| 구성 요소 | 책임 | 위치 |
| --- | --- | --- |
| 수집기 | 소스 7곳에서 신규 항목을 읽어 아카이브에 append 하고 manifest를 갱신한다 | [src/](../src/) |
| 아카이브 | 수집 결과를 담는 JSON 파일들. 시스템의 유일한 상태 | [site/data/](../site/data/), [state/seen/](../state/seen/) |
| 뷰어 | 아카이브 JSON을 읽어 화면을 그리는 정적 페이지. 빌드 없음 | [site/](../site/) |
| 워크플로 | 수집 실행 → 커밋 → Pages 배포 → 실패 보고. 스케줄과 게이트를 담당한다 | [.github/workflows/](../.github/workflows/) |

외부 연동은 소스 7곳에 대한 읽기 전용 HTTP 요청뿐이다. 인증이 필요한 엔드포인트나 비공개 API는 쓰지 않는다. 소스별 요청·파싱 계약은 [spec/sources/](../spec/sources/)에 있다.

**뷰어는 수집기를 모른다.** 뷰어가 아는 것은 `site/data/`의 파일 포맷뿐이고, 수집기는 뷰어를 호출하지 않는다. 둘 사이의 계약이 곧 JSON 스키마다.

## 주요 폴더와 흐름

```
src/
├─ types.ts        아이템 스키마, 컬렉터 인터페이스, manifest 타입
├─ kst.ts          KST 날짜 헬퍼 (단일 진실 공급원)
├─ http.ts         fetch 래퍼: UA 고정, 타임아웃, 재시도, 요청 간 대기
├─ text.ts         결정론적 문자열 처리 (태그 제거·엔티티 디코드·공백 정규화·300자 절단)
├─ flight.ts       Next.js RSC flight 페이로드 파서 (syde·jocohunt·ilddan이 공유)
├─ store.ts        샤드·manifest·seen 인덱스 읽기·쓰기
├─ integrity.ts    아카이브 전량 검증
├─ verify.ts       커밋 직전 게이트. integrity를 호출하고 실패 시 non-zero로 끝난다
├─ run.ts          오케스트레이터
└─ collectors/     소스 1개 = 파일 1개 = 독립적으로 죽을 수 있는 것 1개
```

한 번의 수집 실행이 도는 순서는 `run.ts`가 정한다.

```
소스별 seen 인덱스 로드 → 컬렉터 실행 → parsedCount 검사 → 실행 내 id dedupe
  → seen 대비 필터 → 월 샤드 append → seen 인덱스 갱신
  → showhn 점수 사이드카 재작성 → manifest 재작성 → latest.json 재생성
  → 아카이브 전량 검증 → 실패 요약 보고
```

의존 방향은 한쪽이다. `collectors/*`는 `http.ts`·`text.ts`·`flight.ts`·`types.ts`만 보고 저장 계층을 모른다. `run.ts`만 컬렉터와 `store.ts`를 동시에 안다. `store.ts`는 컬렉터를 모른다.

데이터 파일의 역할 분담:

| 파일 | 누가 쓰나 | 누가 읽나 |
| --- | --- | --- |
| `site/data/YYYY-MM.json` | 수집기 (append) | 뷰어(검색), 수집기 |
| `site/data/YYYY-MM.showhn.json` | 수집기 (append) | 뷰어(Show HN 칩을 고를 때만) |
| `site/data/latest.json` | 수집기 (매 실행 재생성) | 뷰어 기본 화면 |
| `site/data/manifest.json` | 수집기 (매 실행 재작성) | 뷰어, 수집기 |
| `site/data/showhn-scores.json` | 수집기 (매 실행 전량 재작성) | 뷰어(Show HN 칩을 고를 때만) |
| `state/seen/{source}.json` | 수집기 | 수집기만 |

크기와 상세 포맷은 [SPEC.md](../SPEC.md) 2.4에 있다.

## 지켜야 할 구조 규칙

데이터를 잃는 종류의 규칙은 [CLAUDE.md](../CLAUDE.md)가 정본이다. 아래는 그중 구조에 해당하는 것과 그 이유다.

- **소스 1개 = 파일 1개 = 독립적으로 죽을 수 있는 것 1개.** 하나가 깨져도 나머지는 그날 데이터를 남긴다. 컬렉터를 공통 추상으로 묶어 한 지점에서 같이 죽게 만들지 않는다.
- **실패 신호는 `run.ts`가 아니라 워크플로의 마지막 스텝이 낸다.** `run.ts`가 `exit 1`을 하면 커밋 스텝이 실행되지 않아 성공한 소스들의 그날 수집분이 통째로 버려진다. 스텝 순서 `collect → commit/push(if: always()) → deploy → report`를 뒤집지 않는다 ([SPEC.md](../SPEC.md) 4.1).
- **`verify.ts`만 예외로 non-zero로 끝난다.** 수집을 하지 않는 검증기라 여기서 멈춰도 데이터가 날아가지 않고, 멈춰야 깨진 데이터가 배포되지 않는다. 이 검증은 push 재시도 루프 **안**에 있어야 한다 ([SPEC.md](../SPEC.md) 4.4).
- **교차 파일 쓰기 순서는 월 샤드 → seen 인덱스다.** 반대로 쓰면 seen 성공 뒤 샤드 실패 시 항목이 영구 누락된다. 샤드를 먼저 쓰면 seen 실패는 다음 병합이 샤드의 id를 보고 자가복구한다 ([src/run.ts](../src/run.ts)의 `merge`).
- **중복 제거는 `state/seen/{source}.json` 전량 인덱스로 한다.** "최근 N개월 샤드만 읽기"로 바꾸지 않는다 — Disquiet의 배치 승인, Product Hunt의 featured 재노출, SYDE의 끌올이 2개월 창을 전부 뚫는다 ([SPEC.md](../SPEC.md) 3절).
- **`state/`는 `site/` 밖에 둔다.** seen 인덱스는 컬렉터만 읽는다. Show HN은 연 5만 개 id가 쌓이는데 Pages로 배포할 이유가 없다.
- **30일 창이 걸치는 달은 `store.ts`의 `latestWindow` 하나가 정한다.** `rebuildLatest`와 `integrity.ts`가 그 함수를 공유하되 비교 자체는 각자 독립적으로 한다. 두 곳이 같은 상수를 복제하던 동안은 커밋 게이트가 누락을 못 잡았다 ([src/store.ts](../src/store.ts)).
- **임계값은 한 곳에만 둔다.** "며칠째 신규 0건" 판정은 `run.ts`가 내려 manifest에 싣고, 사이트는 그 판정을 렌더만 한다. 사이트가 임계값을 복제하면 두 곳이 어긋날 수 있는 값이 하나 늘어난다 ([src/run.ts](../src/run.ts)의 `staleNewSources`).
- **`check.yml`을 `collect.yml`에 합치지 않는다.** 타입 에러가 수집을 막으면 그날 7개 소스가 통째로 날아간다. 게이트는 코드가 `main`에 닿는 경로에만 둔다.

## 알려진 구조 제약

- **`main` 브랜치에 워크플로가 하루 2회 직접 푸시한다.** 로컬 작업 중 스케줄 수집이 끼어들면 `site/data/*.json`과 `state/seen/*.json`이 갈라진다. 이때 JSON을 병합하지 말고 재계산한다 ([sessions/decisions/2026-07-30-recompute-json-on-divergence.md](../sessions/decisions/2026-07-30-recompute-json-on-divergence.md)).
- **스케줄 발화 시각이 보장되지 않는다.** cron에 적은 시각은 발화 예정이지 실행 시각이 아니며, 실측 13회에서 아침분이 중앙 +68분이었다. 지연은 유실이 아니라 "언제 볼 수 있느냐" 문제다 ([SPEC.md](../SPEC.md) 5절).
- **파이프라인이 조용히 죽는 경로가 있다.** 스케줄 워크플로 자동 비활성화, cron 드롭, Pages 미배포는 Actions를 실패시키지 않아 이메일이 오지 않는다. 그래서 1순위 고장 감지기가 페이지 상단 배너다 ([SPEC.md](../SPEC.md) 4.5).
- **소스 사이트의 구조 변경에 직접 노출된다.** 공개 페이지·피드·엔드포인트를 정규식과 RSC flight 파싱으로 읽으므로 상대가 마크업이나 페이로드 구조를 바꾸면 그 소스가 깨진다. 이것이 `parsedCount === 0`을 throw로 다루는 이유다.
- **뷰어는 빌드도 번들도 없다.** `site/app.js`의 문법 오류는 화면을 흰 화면으로 만들면서 Actions는 초록으로 남긴다. `check.yml`의 `node --check site/app.js`가 막을 수 있는 것은 파싱까지다.
