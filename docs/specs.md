# 기술 명세

어떤 기술과 구현·검증 규칙을 따르는지 다룬다. 구성 요소의 책임과 의존 관계 등 구조 규칙은 [docs/architecture.md](architecture.md)에서 관리한다.

## 기술 구성

| 영역 | 사용하는 것 | 근거 파일 |
| --- | --- | --- |
| 런타임 | Node.js 24 이상. `.ts`를 빌드 없이 직접 실행(타입 스트리핑) | [.nvmrc](../.nvmrc), [.github/workflows/collect.yml](../.github/workflows/collect.yml) |
| 언어 | TypeScript. ESM (`"type": "module"`) | [package.json](../package.json), [tsconfig.json](../tsconfig.json) |
| 런타임 의존성 | **0개.** `src/`는 `node:` 내장과 상대경로 `.ts`만 import 한다 | [package.json](../package.json) |
| 개발 의존성 | `typescript` ^5.9, `@types/node` ^24. CI 검사에서만 쓴다 | [package.json](../package.json) |
| 테스트 | `node:test` (내장). 네트워크를 쓰지 않는다 | [test/](../test/) |
| 뷰어 | 빌드·번들·프레임워크 없는 HTML + CSS + 바닐라 JS | [site/](../site/) |
| 실행·배포 | GitHub Actions, GitHub Pages (Actions 방식 배포) | [.github/workflows/](../.github/workflows/) |
| 저장소 | Git 저장소의 JSON 파일. 별도 DB 없음 | [site/data/](../site/data/), [state/seen/](../state/seen/) |

## 지켜야 할 구현 규칙

- **런타임 npm 의존성 0개를 유지한다.** `package.json`의 `dependencies`는 비어 있어야 한다. Atom도 정규식으로 뽑는다. 복귀 조건은 "XML 파싱이 실제로 깨지면 `fast-xml-parser` 1개까지 허용"이다 ([SPEC.md](../SPEC.md) 8절).
- **지울 수 있는 TypeScript 문법만 쓴다.** `enum`, `namespace`, 파라미터 프로퍼티(`constructor(private x)`)를 쓰지 않는다. `tsconfig.json`의 `erasableSyntaxOnly`가 이를 잡지만 타입 스트리핑 자체는 타입 검사를 하지 않으므로 CI에서 `tsc --noEmit`을 돌린다. 이 문법이 하나 들어가면 `run.ts` 최상단 import에서 로드 시점에 죽어 그날 7개 소스가 통째로 날아간다.
- **컬렉터는 `{ parsedCount, items, warnings, scores? }`를 반환하고 dedupe는 하지 않는다.** dedupe는 `run.ts`가 한다. 파싱 직후 `parsedCount === 0`이면 throw 하고, 신규 0건은 정상으로 둔다 ([SPEC.md](../SPEC.md) 4.3).
- **HTTP 요청은 [src/http.ts](../src/http.ts)를 거친다.** 브라우저 UA 고정, 기본 타임아웃 15초, 재시도(기본 1회, 소스별 조정), 요청 간 300ms 대기가 여기에 있다. 재시도 대상 상태 코드는 403·429·500·502·503·504다.
- **문자열 처리는 결정론적인 것만 쓴다.** 허용되는 것은 [src/text.ts](../src/text.ts)의 태그 제거·엔티티 디코드·공백 정규화·300자 절단뿐이다. LLM 요약·분류·태깅·키워드 필터를 추가하지 않는다 ([CLAUDE.md](../CLAUDE.md)).
- **날짜는 [src/kst.ts](../src/kst.ts)만 쓴다.** `Intl.DateTimeFormat`에 `timeZone: 'Asia/Seoul'`을 준 단일 진실 공급원이다. 샤드 키와 `collectedDate`가 전부 여기서 나온다.
- **파일 쓰기는 `*.tmp`에 쓰고 → 다시 읽어 `JSON.parse` 검증 → rename 이다** ([src/store.ts](../src/store.ts)의 `writeJsonAtomic`).
- **샤드는 "항목 1개 = 1줄" append-only**, `showhn-scores.json`은 "키 1개 = 1줄, 키 정렬"로 쓴다. git 일일 델타를 바뀐 줄만큼으로 줄이기 위한 포맷이며, 정렬은 사이트가 표시할 때 한다.
- **사이트와 수집기가 같은 판정을 두 번 구현하지 않는다.** 임계값은 `run.ts`에 두고 manifest로 넘긴다. `site/app.js`의 `ALERT_STALL_MS`처럼 양쪽에 있어야 하는 값은 같은 값임을 주석으로 명시한다.
- **소스를 추가할 때는 공개된 페이지·피드·엔드포인트를 정상적으로 읽는 방법만 쓴다.** JS 번들 역설계나 비공개 API 탐색은 하지 않는다 ([CLAUDE.md](../CLAUDE.md)).

## 실행과 검증

| 목적 | 명령 또는 확인 방법 | 필요한 조건 |
| --- | --- | --- |
| 준비 | `npm ci` | Node 24 이상. devDependencies만 설치한다 |
| 실행 (수집) | `node src/run.ts` | Node 24 이상, 네트워크. 파일을 쓴다 |
| 실행 (수집 확인만) | `node src/run.ts --dry-run` | Node 24 이상, 네트워크. 파일을 쓰지 않는다 |
| 실행 (뷰어) | `npx serve site` | 정적 파일 서버면 무엇이든 된다. 미확인 — 이 세션에서 실행하지 않았다 |
| 테스트 | `node --test 'test/*.test.ts'` | Node 24 이상. 네트워크 불필요 |
| 정적 검사 | `npx tsc --noEmit` | devDependencies 설치 필요 |
| 데이터 검증 | `node src/verify.ts` | Node 24 이상. 커밋 직전 게이트와 같은 것. 실패 시 non-zero |
| 뷰어 문법 검사 | `node --check site/app.js` | `check.yml`이 도는 것과 같은 검사 |

고치기 전후로 [CLAUDE.md](../CLAUDE.md)가 지정한 묶음을 돌린다.

```bash
npm ci && npx tsc --noEmit && node --test 'test/*.test.ts' && node src/verify.ts
```

`node --test test/`는 동작하지 않는다. Node가 디렉터리를 모듈 경로로 읽으므로 반드시 글롭이어야 한다.

2026-09-22 확인 결과 (macOS, Node v24.19.0): `npx tsc --noEmit` 통과, `node --test 'test/*.test.ts'` 78개 전부 통과, `node src/verify.ts`가 `site/data OK`로 정상 종료. `npm ci`는 `--dry-run`으로만 확인했다(`up to date`).

`run.ts`의 플래그:

| 플래그 | 하는 일 |
| --- | --- |
| `--dry-run` | 파일을 쓰지 않고 수집과 신규 예상 건수만 출력한다 |
| `--only=<source>` | 소스를 골라 실행한다. 쉼표로 여러 개 가능 |
| `--seed` | `collectedAt`을 48시간 백데이트해 "오늘 신규"에 띄우지 않는다. **빈 아카이브에서만 쓴다** |
| `--rebuild-seen` | `state/seen/*.json`을 아카이브에서 되만든다. 소스에 요청이 나가지 않는다 |
| `--replay` | 직전 실행 결과 파일을 다시 병합한다. 워크플로의 push 재시도 루프가 쓴다 |

**seen 인덱스를 잃었을 때의 복구는 `--rebuild-seen`이지 `--seed`가 아니다.** seed는 백데이트 때문에 append 순서 단언을 깨뜨려 그 뒤로 아무것도 커밋되지 않는 상태를 만든다 ([SPEC.md](../SPEC.md) 3절).

환경 변수 (이름과 용도만 적는다. 비밀값은 쓰지 않는다):

| 이름 | 용도 | 기본값 |
| --- | --- | --- |
| `IDEA_RADAR_ROOT` | 데이터 디렉터리의 기준 경로. 테스트가 임시 디렉터리를 가리킬 때 쓴다 | 저장소 루트 |
| `IDEA_RADAR_RUN_FILE` | `--replay`가 읽는 직전 실행 결과 파일의 경로 | OS 임시 디렉터리 |
| `GITHUB_OUTPUT` | Actions가 주입한다. `run.ts`가 실패 요약을 여기에 쓴다 | 없음 (로컬에서는 콘솔 출력만) |

수집 자격 증명이나 API 키는 사용하지 않는다. 워크플로가 쓰는 권한은 `contents: write`, `pages: write`, `id-token: write`뿐이다.

CI는 두 워크플로로 나뉘어 있다. [check.yml](../.github/workflows/check.yml)은 `src/`·`test/`·`site/app.js`·설정 파일이 바뀌는 경로에서만 돌고, [collect.yml](../.github/workflows/collect.yml)은 `npm`을 아예 실행하지 않는다. **두 워크플로를 합치지 않는다** — 이유는 [docs/architecture.md](architecture.md)의 구조 규칙에 있다.

## 알려진 기술 제약

- **Node 24 미만에서는 아무것도 실행되지 않는다.** `.ts` 직접 실행이 `ERR_UNKNOWN_FILE_EXTENSION`으로 죽는다. 이 저장소를 여는 셸의 기본 Node가 20이면 `node --test`와 `node src/verify.ts`가 전부 실패하므로, 검증 결과를 기록할 때 확인한 Node 버전을 함께 적는다. `npx tsc --noEmit`은 타입 스트리핑을 쓰지 않아 낮은 버전에서도 통과하므로 이것만으로 환경을 판단하면 안 된다.
- **타입 스트리핑은 타입 검사를 하지 않는다.** 타입이 틀려도 실행은 되고, CI의 `tsc --noEmit`이 없으면 아무도 잡지 않는다.
- **`site/app.js`는 타입 검사 대상이 아니다.** `tsconfig.json`의 `include`는 `src`와 `test`뿐이다. `check.yml`의 `node --check`가 파싱 오류까지만 잡는다.
- **테스트는 네트워크를 쓰지 않는다.** 컬렉터가 실제 소스와 맞는지는 테스트가 아니라 `--dry-run` 실행으로 확인한다.
- **로컬에서 되는 것과 러너에서 되는 것이 다르다.** GitHub IP가 차단당하는 소스가 있을 수 있어, 컬렉터 변경은 `workflow_dispatch`로 실제 러너에서 한 번 확인한다 ([TASKS.md](../TASKS.md) 5절).
- **재현 가능한 수집이 아니다.** 소스 사이트의 현재 상태에 의존하므로 같은 명령을 두 번 돌려도 같은 결과가 나오지 않는다. 두 번째 실행의 신규가 0건인 것이 정상이다.
