# 프로젝트 문서

## 현재 상황

idea-radar는 신규 앱·웹서비스를 매일 아침 한 페이지에서 훑고 나중에 검색해 다시 찾기 위한 개인용 아카이브다. GitHub Actions가 하루 2회 소스 7곳을 수집해 JSON으로 커밋하고, 같은 저장소의 GitHub Pages가 그것을 정적 페이지로 보여준다. 서버·DB 없이 저장소 하나로 돌아간다.

2026-07-29 시딩 이후 하루 2회 수집이 계속 돌고 있다. 2026-09-22 기준 `site/data/manifest.json`의 7개 소스가 모두 `consecutiveFailures: 0`이고 월 샤드는 2026-07·08·09 세 달치가 있다. 구현은 [TASKS.md](../TASKS.md) 0~7절까지 끝났고, 남은 것은 8절 kill test 하나다.

## 이 프로젝트의 정본은 SPEC.md다

`docs/`는 [SPEC.md](../SPEC.md)를 대신하지 않는다. 동작·데이터 모델·실패 처리의 정본은 `SPEC.md`이고, `docs/`는 진입점과 요약만 두고 해당 절을 링크한다. 두 문서가 어긋나면 `SPEC.md`가 맞다.

| 파일 | 역할 |
| --- | --- |
| [SPEC.md](../SPEC.md) | 아키텍처, 데이터 모델, 실패 처리, 사이트 동작 — 구현 전 필독 |
| [CLAUDE.md](../CLAUDE.md) | 깨면 데이터를 잃는 불변식 |
| [AGENTS.md](../AGENTS.md) | 에이전트의 문서 읽기·작성 규칙 |
| [TASKS.md](../TASKS.md) | 구현 순서의 기록. 현재 동작의 정본이 아니다 |
| [spec/sources/](../spec/sources/) | 소스별 수집 계약 7개 (2026-07-29 실측 기반) |
| [spec/source-research.json](../spec/source-research.json) | 현재·후보·제외 소스의 실측 조사 원본 |
| [sessions/](../sessions/) | 문서 구조 도입 이전의 세션 기록과 결정 노트 |

## 기본 문서

- [docs/plan.md](plan.md): 제품 목적, 사용자, 기능 범위, 사용자 흐름, 제품 정책
- [docs/architecture.md](architecture.md): 구성 요소, 폴더 책임, 의존 관계, 구조 규칙
- [docs/specs.md](specs.md): 기술 스택, 구현 규칙, 실행·검증 방법

제품 기획 → 구조 → 구현 규칙 순으로 안내한다. 매 작업마다 전부 읽을 필요는 없으며, 현재 작업에 필요한 문서를 선택한다. 수집 파이프라인을 고칠 때는 여기 요약만 읽지 말고 [CLAUDE.md](../CLAUDE.md)와 [SPEC.md](../SPEC.md)의 해당 절을 읽는다.

## 선택 문서

- [docs/design.md](design.md): UI 디자인 기준, 관찰된 구현, 코드·화면 근거

`site/`에 빌드 없는 정적 UI가 있어 사용한다. UI를 추가·수정·검토하기 전에 관련 부분을 확인한다.

## 진행 중·예정·보류 작업

- [docs/work/W-001-main-kill-test.md](work/W-001-main-kill-test.md) — 2주 뒤 kill test와 그 뒤 판단 — 예정
- [docs/work/W-002-main-ui-usability.md](work/W-002-main-ui-usability.md) — 사이트 사용성·UI 개선(검색·신선도 판정·실행 경계·다크 대비·브랜드 에셋). 구현과 헤드리스 검증은 끝났고 커밋·실기기 확인이 남음 — 진행 중

상태는 `예정`, `진행 중`, `보류`, `완료`를 사용한다. 상세 내용은 작업 문서에서 관리한다.

## 최근 완료

완료한 작업이 없다. 문서 구조 도입 이전의 작업은 [TASKS.md](../TASKS.md)의 체크리스트와 [sessions/](../sessions/)의 기록에 남아 있다.

## 사람이 판단할 사항

- **세션 기록을 어디에 둘 것인가.** 기존 [sessions/](../sessions/)와 새로 생긴 `docs/sessions/`가 같은 역할을 한다. 기존 파일은 [README.md](../README.md)와 [SPEC.md](../SPEC.md)가 상대경로로 참조하고 있어 옮기면 링크를 함께 고쳐야 하므로, 이번에는 그 자리에 뒀다. 한쪽으로 합칠지는 결정되지 않았다.
- **사이트 개선(W-002)에서 바꾼 피드 동작과 다크 팔레트를 유지할지.** 수집 실행 경계, `1일`→`오늘`, 같은 실행 안의 소스 칩 순서, 다크 `--fg-faint`·`--edge` 값이다. 근거와 되돌리는 방법은 [docs/work/W-002-main-ui-usability.md](work/W-002-main-ui-usability.md)에 있다.
- **kill test를 실제로 했는지 확인이 필요하다.** [TASKS.md](../TASKS.md) 8절의 예정일은 2026-08-12인데 저장소에 실행 기록이 없다. 자세한 내용은 [docs/work/W-001-main-kill-test.md](work/W-001-main-kill-test.md)에 있다.

## 기록을 찾을 때

작업 문서의 ‘현재 상황’과 ‘남은 일’의 미완료 항목부터 읽는다. 완료한 항목은 체크된 상태로 남아 있다. 보류 이유와 재개 조건은 ‘현재 상황’에, 선택한 이유와 검증 결과는 ‘진행과 판단’에 있다. 상세 세션 기록이 있으면 해당 작업 문서에서 연결한다.

문서 작성·갱신 규칙은 [AGENTS.md](../AGENTS.md)를 참고한다.
