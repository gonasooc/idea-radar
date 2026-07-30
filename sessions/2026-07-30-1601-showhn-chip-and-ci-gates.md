---
date: 2026-07-30T16:01+0900
machine: Joelui-MacBookPro
agent: claude-code
branch: main
commit: 181fea4
tree: clean
status: done
---

# Show HN을 소스 칩으로 통합하고 검증 게이트를 붙임

## Goal

v1 가동 3일차 코드베이스를 점검해 기능 추가·개선 지점을 찾고, SPEC이 스스로 "1순위"라 지정했지만 실제로는 구현되지 않은 고장 감지 장치를 완성한다. 2주 kill test 전이라 새 기능은 넣지 않는다(TASKS.md §8).

## State

**Verified** — 전부 실행해서 출력을 확인한 것

- 테스트 48건 통과. 로컬(node v26.5.0)과 GitHub 러너(**node v24.18.0**) 양쪽. 러너 로그에서 `tests 48 / pass 48 / fail 0` 확인 — 0건으로 조용히 넘어간 게 아니다. `import.meta.main`과 `node --test 'test/*.test.ts'`의 `.ts` 탐색 둘 다 24에서 동작한다.
- `npx tsc --noEmit` exit 0. 로컬·러너 양쪽. (작업 전에는 `@types/node` 부재로 16건 실패했다.)
- `src/verify.ts`가 깨진 manifest와 깨진 JSON에 각각 exit 1, 복구 후 exit 0.
- 7개 소스 `--dry-run` 전부 `parsedCount` 0 아님, 경고 0건.
- 사이트(브라우저 실측): Show HN 칩이 sidecar 점수 내림차순(711p/169p/79p…)으로 정렬. 소스 칩 Disquiet + 검색 → Disquiet 결과만, `2026-07.json`만 요청. Show HN 칩 + 검색 → Show HN만, `.showhn.json`만 요청. 정지/주의 배너 양쪽 렌더. `latest.json` 재요청 `transferSize: 0` / `encodedBodySize: 130619`.
- 신규 UI 요소 대비 계산: 라이트 5.98~6.63:1, 다크 6.31~10.05:1. 정지 칩 테두리만 1.72:1인데 기존 `--edge`(1.74:1)와 같은 급이고 상태는 글자색(6.57:1)이 진다.
- jocohunt 홈: 파서 정상(청크 70, flight 138,682, `"products":[` @82,777), 배열이 진짜로 `[]`. 실제 제품은 RSC 엘리먼트 트리로만 존재. 홈의 실제 제품 6건 전부 sitemap에 있음(발견 누락 0). 상세 og 파싱이 spec 샘플과 일치. `k3xq9p2m`은 제품이 아니라 출시 폼 i18n 예시 문자열.
- jocohunt 30일 백필 완료: 창 안 59건 중 미수집 0건.
- 배포 확인: `showhn-scores.json` 200/8,932바이트, `app.js`에 `showhn-scores`·`sourceHealth` 존재, `showhnToggle` 없음. `check`·`collect` 워크플로 둘 다 `181fea4`에서 success.

**Assumed** — 코드는 있으나 실행해 보지 않은 것

- **`verify.ts`가 실제 수집 경로에서 도는 것.** `181fea4`에서 돈 `collect`는 push 트리거라 수집 스텝을 건너뛰는 경로였다. 12:07 KST 스케줄 실행이 첫 검증이다.
- **push 재시도 루프의 `run.ts --replay` + `verify.ts` 상호작용.** 실제 push 충돌이 있어야 재현된다.
- **sidecar 파일이 없을 때의 폴백.** 브라우저 테스트 전에 파일을 이미 생성해서 부재 경로를 밟지 않았다.
- Show HN 창이 월 경계를 걸칠 때(7/30일 칩)의 sidecar 동작. 96시간 창 밖 항목이 얼어붙은 score로 남는 경로.
- `renderShowhnFeed`의 0건 분기.

**Not started** — 의도적으로 범위 밖

- 상단 "이번 수집 신규" 요약 헤더, 2군 소스 추가. 둘 다 2026-08 중순 재판단으로 보류 중.

## Next steps

1. **12:07 KST 스케줄 수집 결과 확인** — `gh run list --workflow=collect.yml --limit 1` 후 `gh run view <id> --log | grep -A3 "verify"`. `node src/verify.ts` 스텝이 정상 경로를 막지 않는지 보는 것이 목적이다.
2. 다 쓴 로컬 브랜치 정리: `git branch -d safety-net` (`main`에 이미 머지됨).
3. 2026-08 중순, v1 2주 생존 시점에 보류 항목 재판단. jocohunt 백필이 끝나 물량 기준선을 잴 수 있는 상태다.

## Decisions

- [로컬과 origin이 갈라지면 데이터 JSON은 병합하지 말고 재계산한다](decisions/2026-07-30-recompute-json-on-divergence.md)

아래는 저장소 문서에 이미 근거와 함께 기록한 것들이다. 여기 다시 쓰지 않는다.

- Show HN 접힘 블록 제거 → 소스 칩 통합: `SPEC.md` 6.2/6.3 ("왜 접힘 블록을 버렸나"). 사용자 판단이었고, 축이 둘이라 생긴 검색 필터 우회 버그를 인스턴스 패치 대신 구조로 없앴다.
- Show HN 점수 sidecar를 항목 불변성의 예외로 둠: `SPEC.md` 2.2/2.4, `CLAUDE.md` 5.
- `verify.ts`는 `run.ts`와 달리 non-zero로 종료하고 재시도 루프 **안**에 있어야 함: `SPEC.md` 4.4, `CLAUDE.md` 6.
- 소스별 정지 감지를 사이트에 노출, 판정 규칙을 Actions와 동일하게: `SPEC.md` 4.5.
- `check.yml`을 `collect.yml`에 합치지 않음: `SPEC.md` 1절.
- jocohunt 홈 빈 배열을 정상 상태로 취급, RSC 트리는 파싱하지 않음: `spec/sources/4-jocohunt.md` 상단 + 함정 14.

세션 한정 판단으로 기록만 남기는 것:

- Show HN 칩 초기 30건 → 더보기 → 200건 상한. 접힘 블록 시절 15건은 전용 화면이 된 지금 인색하다고 봤다. 근거 없는 조정이므로 불편하면 바꿔도 된다.
- 점수 개선 폭을 계획 단계에서 과장했다가 실측으로 정정했다. seed 제외 199건 기준 상위 15건 교집합은 12/15로, 최상위권 구성은 크게 안 바뀐다. 실제로 고쳐지는 것은 표시 숫자와 하위 절반 순서다.

## Open questions

- `verify.ts`가 실제 수집 경로를 막지 않는지 미확인. 막힌다면 12:07 KST 실행이 빨간불이 되고 그날 수집분은 커밋되지 않는다. → Next steps 1번.
- jocohunt 홈 개편이 되돌려질지 알 수 없다. 되돌아오면 상세 요청 비용(하루 2~3회)이 다시 0이 되지만, 감지 장치는 없다. 지금은 sitemap 경로가 상시 경로라 되돌아와도 손해는 없다.

## Environment

- **미커밋·미푸시 작업 없음.** 워킹 트리 깨끗, `origin/main`과 동기화됨(`181fea4`).
- 로컬 `safety-net` 브랜치가 `007d627`에 남아 있다. `main`에 머지 완료라 삭제해도 된다. 다른 기기에는 존재하지 않는다.
- **PATH 기본 `node`가 v20.19.0이라 이 프로젝트를 실행할 수 없다.** `.ts` 직접 실행에 `ERR_UNKNOWN_FILE_EXTENSION`이 난다. 이 기기에서는 `/opt/homebrew/bin/node`(v26.5.0)를 써야 한다 — 이번 세션의 모든 로컬 검증이 그것으로 돌았다. `.nvmrc`는 24를 지정하지만 nvm에 v24 설치본이 없다. 다른 기기에서는 `nvm install 24` 또는 동등한 조치가 필요하다.
- `node_modules/`가 로컬에 있다(gitignore 대상). 새 기기에서는 `npm ci` 필요.
- 필요한 환경변수 없음. 실행 중이어야 하는 로컬 서비스·포트·컨테이너 없음.
- `IDEA_RADAR_ROOT`, `IDEA_RADAR_RUN_FILE` 환경변수를 코드가 읽지만 둘 다 선택이고 테스트에서만 쓴다.

## References

- 이번 세션 커밋: `b281ad8` `44d5ffd` `8f1012f` `7f11a75` `007d627` `181fea4`
- 세션 중 origin에 끼어든 스케줄 수집: `525b2e2`
- `SPEC.md` 1 / 2.2 / 2.4 / 4.4 / 4.5 / 6.2 / 6.3
- `spec/sources/4-jocohunt.md` 상단 경고 + H11 + F1 + 함정 14
- `CLAUDE.md` 불변식 5·6, "고치기 전에 돌릴 것"
- 사이트: https://gonasooc.github.io/idea-radar/
- 워크플로: `.github/workflows/check.yml`(신설), `collect.yml`, `keepalive.yml`
- 검증 명령: `npm ci && npx tsc --noEmit && node --test 'test/*.test.ts' && node src/verify.ts`

## Suggested skills

- `session-resume` — 다음 세션 시작 시. 특히 Environment의 node 버전 항목과 Assumed의 `verify.ts` 미검증 항목을 실제 상태와 대조할 것.
