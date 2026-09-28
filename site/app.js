'use strict';

const SOURCES = {
  'geeknews-show': 'GeekNews',
  disquiet: 'Disquiet',
  syde: 'SYDE',
  jocohunt: '조코헌트',
  ilddan: '일딴',
  producthunt: 'Product Hunt',
  showhn: 'Show HN',
};
const LS_CACHE = 'idea-radar.cache';
const LS_THEME = 'idea-radar.theme';
const LS_DAYS = 'idea-radar.feedDays';
const SS_SCROLL = 'idea-radar.scrollY';
const STALE_MS = 26 * 3600 * 1000;
// src/run.ts의 alert 규칙과 같은 값이어야 한다. 사이트와 Actions가 다른 말을 하면 안 된다.
const ALERT_STALL_MS = 40 * 3600 * 1000;
const FEED_DAYS = [['1', '오늘'], ['3', '3일'], ['7', '7일'], ['30', '30일']];
const SEARCH_PERIODS = [['1', '1개월'], ['3', '3개월'], ['12', '12개월'], ['all', '전체 기간']];
const FEED_CAP = 300;
const SEARCH_CAP = 300;
const SHOWHN_INITIAL = 30;
const SHOWHN_CAP = 200;
// 탭이나 홈 화면 앱으로 돌아왔을 때 마지막 확인에서 이만큼 지났으면 manifest를 다시 본다.
// 홈 화면 앱은 밤새 메모리에 남았다가 아침에 새로 고침 없이 그대로 복귀한다 (SPEC 6.4).
const RESUME_REFRESH_MS = 10 * 60 * 1000;
// 같은 실행에서 들어온 항목은 collectedAt이 같다. 그때는 소스 칩 순서로 둔다 (SPEC 6.2).
const SOURCE_RANK = Object.fromEntries(Object.keys(SOURCES).map((key, i) => [key, i]));

const $ = (id) => document.getElementById(id);
const els = {
  banner: $('banner'),
  sourceBanner: $('sourceBanner'),
  searchForm: $('searchForm'),
  q: $('q'),
  sourceChips: $('sourceChips'),
  dayChips: $('dayChips'),
  periodChips: $('periodChips'),
  countLine: $('countLine'),
  list: $('list'),
  themeToggle: $('themeToggle'),
  footNote: $('footNote'),
};

const state = {
  manifest: null,
  items: [],
  query: '',
  searchSeq: 0,
  // null = 전체(Show HN 제외). Show HN은 물량이 나머지 전체의 5배라 '전체'에 섞지 않는다 (SPEC 6.2).
  sourceFilter: null,
  feedDays: '3',
  feedExpanded: false,
  searchPeriod: '12',
  showhnItems: null,
  showhnLoading: false,
  // 이번 방문에서 manifest를 실제로 받았는가 / 가장 최근 시도가 실패했는가. 캐시로 먼저 그린 화면은
  // 수집이 멈췄는지 판정할 근거가 못 된다 — 오래 안 열었을 뿐인데 빨간 배너가 뜬다.
  checked: false,
  offline: false,
};

const kstDay = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });
const kstFull = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
const kstISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const kstTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}
function ssGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function ssSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch {}
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

// 검색어는 공백으로 나눈 단어들이다. 순서와 상관없이 전부 들어 있어야 매칭된다 (SPEC 6.3).
function searchTerms(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// 검색어 위치를 <mark>로 감싼다. 문자열은 텍스트 노드로만 넣는다 — 원문을 HTML로 해석하지 않는다.
function appendMarked(el, text, terms) {
  const lower = text.toLowerCase();
  // toLowerCase가 길이를 바꾸는 문자(İ 등)가 섞이면 위치가 어긋나므로 강조 없이 넣는다
  if (!terms || terms.length === 0 || lower.length !== text.length) {
    el.appendChild(document.createTextNode(text));
    return;
  }
  const ranges = [];
  for (const t of terms) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) ranges.push([i, i + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (let k = 0; k < ranges.length;) {
    const start = ranges[k][0];
    let end = ranges[k][1];
    for (k++; k < ranges.length && ranges[k][0] <= end; k++) end = Math.max(end, ranges[k][1]);
    if (start > pos) el.appendChild(document.createTextNode(text.slice(pos, start)));
    el.appendChild(h('mark', { text: text.slice(start, end) }));
    pos = end;
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
}

function itemRow(item, opts) {
  const terms = opts && opts.terms;
  const title = h('span', { class: 't' });
  title.appendChild(h('span', { class: 'badge', text: SOURCES[item.source] || item.source }));
  appendMarked(title, item.title, terms);
  if (opts && opts.showDate) title.appendChild(h('span', { class: 'when', text: item.collectedDate }));
  if (opts && opts.score !== undefined) title.appendChild(h('span', { class: 'when', text: `${opts.score}점` }));
  const row = h('a', { class: 'row', href: item.url, target: '_blank', rel: 'noopener' }, title);
  if (item.description) {
    const desc = h('span', { class: 'd' });
    appendMarked(desc, item.description, terms);
    row.appendChild(desc);
  }
  const wrap = h('div', { class: 'item-wrap', 'data-id': item.id }, row);
  if (item.externalUrl) {
    // 행 오른쪽 여백 전체가 이 링크의 탭 영역이고, 보이는 상자는 안쪽 span이 그린다 (style.css .ext).
    // U+FE0E는 iOS가 ↗를 컬러 이모지로 바꾸지 않게 한다.
    wrap.appendChild(h('a', {
      class: 'ext', href: item.externalUrl, target: '_blank', rel: 'noopener',
      title: '제품 사이트 열기', 'aria-label': `${item.title} 제품 사이트 열기`,
    }, h('span', { 'aria-hidden': 'true', text: '↗\uFE0E' })));
  }
  return wrap;
}

// 최신 collectedAt이 위. 같은 실행에서 함께 들어와 collectedAt이 같으면 소스 칩 순서로 둔다 —
// 한 번에 수십 건이 들어오는 Product Hunt가 같은 실행의 국내 소스를 아래로 밀어내지 않게 한다.
// 동점을 정의하지 않던 예전 비교 함수는 V8·JavaScriptCore 모두에서 같은 실행 안의 순서를 뒤집었다.
function byNewest(a, b) {
  if (a.collectedAt !== b.collectedAt) return a.collectedAt < b.collectedAt ? 1 : -1;
  return (SOURCE_RANK[a.source] ?? 99) - (SOURCE_RANK[b.source] ?? 99);
}

// 피드 범위는 KST 캘린더 날짜로만 정한다 — 방문 기록이나 실행 시각에 의존하지 않는다.
// collectedDate가 이미 KST 날짜 문자열이라 문자열 비교로 끝난다.
function feedCutoffDate() {
  const today = kstISO.format(new Date());
  const days = Number(state.feedDays);
  if (days <= 1) return today;
  return kstISO.format(new Date(Date.parse(`${today}T00:00:00+09:00`) - (days - 1) * 24 * 3600 * 1000));
}

function feedDaysLabel() {
  const found = FEED_DAYS.find(([value]) => value === state.feedDays);
  return found ? found[1] : `${state.feedDays}일`;
}

// 1일 창은 KST 오늘 하루다(6.1). '최근 1일'은 지난 24시간으로 읽혀 어제 오후분이 있으리라 기대하게 한다.
function feedRangeLabel() {
  return state.feedDays === '1' ? '오늘' : `최근 ${feedDaysLabel()}`;
}

function lastCollectedNote() {
  return state.manifest ? `${kstFull.format(new Date(state.manifest.updatedAt))} KST` : '';
}

function retryButton(onClick) {
  return h('button', { class: 'retry-btn', type: 'button', text: '다시 시도', onclick: onClick });
}

// "수집이 멈췄다"는 방금 받은 manifest로만 판정한다. 받는 중(캐시로 그린 첫 화면)에는 말하지 않는다 —
// 오래 안 열었을 뿐인데 빨간 배너가 떴다가 사라진다. 받지 못했으면 같은 26시간 조건에서 수집이 아니라
// 이쪽 연결 문제로 말한다(둘은 대응이 다르다). 경고가 뜨는 조건 자체는 줄지 않는다 (SPEC 4.5).
// 홈 화면 앱에는 새로고침 버튼이 없어 다시 시도할 수단을 배너에 둔다.
function renderBanner() {
  const m = state.manifest;
  const age = m ? Date.now() - Date.parse(m.updatedAt) : 0;
  els.banner.className = '';
  if (!m || age <= STALE_MS || (!state.checked && !state.offline)) {
    els.banner.hidden = true;
    return;
  }
  const at = `${kstFull.format(new Date(m.updatedAt))} KST`;
  if (state.offline) {
    els.banner.className = 'net-warn';
    const text = h('div', {});
    setLines(text, ['새 데이터를 확인하지 못했습니다', `${at} 수집분 표시 중`]);
    els.banner.textContent = '';
    els.banner.appendChild(text);
    els.banner.appendChild(retryButton(() => refresh()));
  } else {
    const days = Math.max(1, Math.floor(age / (24 * 3600 * 1000)));
    els.banner.textContent = `수집이 ${days}일째 멈춤 (마지막 성공 ${at})`;
  }
  els.banner.hidden = false;
}

// 전역 배너(updatedAt 기준)는 수집 자체가 멈춘 것만 잡는다. 소스 1개가 죽고 나머지 6개가
// 계속 돌면 updatedAt은 신선하니 배너가 안 뜨고, Actions도 40시간까지 조용하다 (SPEC 4.5).
// 판정 규칙은 src/run.ts의 alert 규칙과 동일하게 맞춘다.
// 파싱은 멀쩡한데 신규가 며칠째 0건인 소스는 위 두 장치가 전부 못 잡는다 — consecutiveFailures가
// 0이고 lastSuccessAt도 신선하기 때문이다 (SPEC 4.5 여섯 번째). 판정은 run.ts가 소스별 임계값으로
// 이미 내렸고 여기서는 렌더만 한다. 임계값을 이쪽에 복제하면 두 곳이 어긋날 수 있는 값이 하나 는다.
function sourceHealth() {
  const stalled = new Map();
  const warned = new Map();
  const dry = new Map();
  // manifest를 받는 중에는 판정을 미룬다(renderBanner 주석). 받지 못했으면 캐시로 판정한다 —
  // 경고가 뜨는 조건을 줄이지 않는다. 놓치는 쪽으로는 틀리지 않는다 (SPEC 4.5).
  const judged = state.checked || state.offline;
  const sources = (judged && state.manifest && state.manifest.sources) || {};
  for (const [key, s] of Object.entries(sources)) {
    if (!s) continue;
    if (s.staleNew) dry.set(key, s.staleNew);
    if (!(s.consecutiveFailures > 0)) continue;
    const noRecentSuccess = !s.lastSuccessAt || Date.parse(s.lastSuccessAt) < Date.now() - ALERT_STALL_MS;
    if (s.consecutiveFailures >= 2 && noRecentSuccess) stalled.set(key, s);
    else warned.set(key, s);
  }
  return { stalled, warned, dry };
}

// 차단(403/429)과 파싱 깨짐은 대응이 다르다 — kind/status를 반드시 남긴다 (SPEC 2.4).
function errorNote(s) {
  const e = s.lastError;
  if (!e || !e.kind) return '';
  return ` (${e.kind}${e.status ? ' ' + e.status : ''})`;
}

// 소스 여러 곳의 상태가 한 덩어리 문장으로 이어지지 않게 소스마다 한 줄씩 쓴다.
function setLines(el, lines) {
  el.textContent = '';
  for (const line of lines) el.appendChild(h('div', { text: line }));
}

// 빈 화면 대신 두는 안내 (SPEC 6.5). 첫 줄이 무슨 상태인지, 둘째 줄이 그 근거다.
function emptyNote(...lines) {
  const el = h('div', { class: 'empty' });
  setLines(el, lines.filter(Boolean));
  return el;
}

function renderSourceBanner(health) {
  const stalled = [...health.stalled].map(([key, s]) => {
    const at = s.lastSuccessAt ? `마지막 성공 ${kstFull.format(new Date(s.lastSuccessAt))} KST` : '성공 이력 없음';
    return `${SOURCES[key] || key} 수집 멈춤 · ${at}${errorNote(s)}`;
  });
  if (stalled.length > 0) {
    setLines(els.sourceBanner, stalled);
    els.sourceBanner.className = 'src-alert';
    els.sourceBanner.hidden = false;
    return;
  }
  // 수집은 되는데 신규가 마른 소스는 조용한 회색 줄을 실패 경고와 같이 쓴다. 빨간불로 올리지
  // 않는 이유는 SPEC 4.2와 같다 — 소스가 죽은 게 아니라 그쪽에 올라온 게 없는 것이다.
  const quiet = [
    ...[...health.warned].map(([key, s]) => `${SOURCES[key] || key} 직전 실행 실패${errorNote(s)}`),
    ...[...health.dry].map(([key, s]) =>
      s.days === null
        ? `${SOURCES[key] || key} 신규 유입 없음 · 최근 2개월 기록 없음`
        : `${SOURCES[key] || key} 신규 ${s.days}일째 0건 · 마지막 ${s.lastNewDate}`),
  ];
  if (quiet.length > 0) {
    setLines(els.sourceBanner, quiet);
    els.sourceBanner.className = 'src-warn';
    els.sourceBanner.hidden = false;
    return;
  }
  els.sourceBanner.hidden = true;
}

function renderFeed() {
  els.periodChips.hidden = true;
  renderDayChips();
  if (state.sourceFilter === 'showhn') { renderShowhnFeed(); return; }

  els.list.textContent = '';
  els.footNote.textContent = '30일 이전 항목은 검색으로 찾을 수 있습니다';
  // 캐시 없는 첫 방문: 칩은 이미 그렸다. 건수는 아직 모르니 비우고 목록 자리에 불러오는 중임을 알린다.
  if (!state.manifest) {
    els.countLine.textContent = '';
    els.list.appendChild(emptyNote('데이터 불러오는 중…'));
    return;
  }

  const since = feedCutoffDate();
  const all = state.items.filter((it) => it.collectedDate >= since).sort(byNewest);
  const shown = state.sourceFilter === null ? all : all.filter((it) => it.source === state.sourceFilter);
  const filterNote = shown.length !== all.length ? ` · 표시 ${shown.length}건` : '';
  els.countLine.textContent = `${feedRangeLabel()} ${all.length}건${filterNote}`;

  if (shown.length === 0) {
    els.list.appendChild(state.sourceFilter !== null && all.length > 0
      ? emptyNote(...sourceEmptyLines(state.sourceFilter))
      : emptyNote(`${feedRangeLabel()} 수집된 항목 없음`, `마지막 수집 ${lastCollectedNote()}`));
  } else {
    const visible = state.feedExpanded ? shown : shown.slice(0, FEED_CAP);
    // 헤더 건수는 절단 전 전체 수다 (SPEC 6.1). 날짜와 수집 실행(같은 collectedAt)별로 한 번에 센다.
    const dayCount = new Map();
    const runCount = new Map();
    for (const it of shown) {
      dayCount.set(it.collectedDate, (dayCount.get(it.collectedDate) || 0) + 1);
      runCount.set(it.collectedAt, (runCount.get(it.collectedAt) || 0) + 1);
    }
    const today = kstISO.format(new Date());
    const yesterday = kstISO.format(new Date(Date.parse(`${today}T00:00:00+09:00`) - 24 * 3600 * 1000));
    let currentDate = '';
    let currentRun = '';
    for (const it of visible) {
      if (it.collectedDate !== currentDate) {
        currentDate = it.collectedDate;
        const rel = currentDate === today ? '오늘 · ' : currentDate === yesterday ? '어제 · ' : '';
        const label = kstDay.format(new Date(currentDate + 'T12:00:00+09:00'));
        els.list.appendChild(h('h2', { class: 'day-head', text: `${rel}${label} · ${dayCount.get(currentDate)}건` }));
      }
      // 수집은 하루 두 번이다. 실행마다 시각을 달아 두면 아침에 "어제 오전분부터는 봤다"를 제목을
      // 외우지 않고 찾는다. collectedAt에서 나온 값이라 어느 기기에서나 같다 — 읽음 상태가 아니다 (SPEC 6.1).
      if (it.collectedAt !== currentRun) {
        currentRun = it.collectedAt;
        els.list.appendChild(h('h3', { class: 'run-head', text: `${kstTime.format(new Date(currentRun))} 수집 · ${runCount.get(currentRun)}건` }));
      }
      els.list.appendChild(itemRow(it));
    }
    appendMoreButton(shown.length - visible.length);
  }
}

// 소스 필터 때문에 0건이면 수집이 멈춘 것과 구분해서 말하고 (SPEC 6.5), 그 소스의 가장 최근 항목
// 날짜를 붙인다 — 기간을 넓혀야 하는지 바로 안다. latest.json이 30일치라 그 안에서만 찾는다.
function sourceEmptyLines(key) {
  let last = '';
  for (const it of state.items) if (it.source === key && it.collectedDate > last) last = it.collectedDate;
  const note = `선택한 소스(${SOURCES[key] || key})에 ${feedRangeLabel()} 항목 없음`;
  if (last) return [note, `가장 최근 항목 ${kstDay.format(new Date(last + 'T12:00:00+09:00'))}`];
  return [note, state.feedDays === '30' ? '' : '최근 30일에도 없음'];
}

function appendMoreButton(rest) {
  if (rest <= 0) return;
  els.list.appendChild(h('button', {
    class: 'more-btn',
    text: `남은 ${rest}건 보기`,
    onclick: () => { state.feedExpanded = true; render(); },
  }));
}

// Show HN은 점수 내림차순이다 — 날짜 헤더를 붙이지 않는다. 하루 140~165건이라 역시간순으로
// 늘어놓으면 훑을 수 없고, 이 화면의 목적이 '많은 것 중 좋은 것'이다.
function renderShowhnFeed() {
  els.list.textContent = '';
  els.footNote.textContent = '30일 이전 항목은 검색으로 찾을 수 있습니다';

  if (state.showhnItems === null) {
    els.countLine.textContent = `${feedRangeLabel()} Show HN`;
    els.list.appendChild(h('div', { class: 'status', text: 'Show HN 불러오는 중…' }));
    // manifest가 아직 없으면(첫 방문) 어느 달을 읽을지 모른다. refresh()가 데이터를 받은 뒤 다시 그린다.
    if (!state.showhnLoading && state.manifest) {
      state.showhnLoading = true;
      loadShowhn().then((items) => {
        state.showhnLoading = false;
        state.showhnItems = items;
        if (state.sourceFilter === 'showhn' && !state.query) render();
      }).catch(() => {
        state.showhnLoading = false;
        // 그 사이 다른 소스나 검색으로 옮겨 갔으면 지금 목록을 덮지 않는다
        if (state.sourceFilter !== 'showhn' || state.query) return;
        els.list.textContent = '';
        const note = emptyNote('Show HN을 불러오지 못했습니다', '네트워크를 확인하고 다시 시도하세요');
        note.appendChild(retryButton(() => render()));
        els.list.appendChild(note);
      });
    }
    return;
  }

  const items = state.showhnItems;
  els.countLine.textContent = `${feedRangeLabel()} Show HN ${items.length}건`;
  if (items.length === 0) {
    const at = lastCollectedNote();
    els.list.appendChild(emptyNote(`${feedRangeLabel()} Show HN 항목 없음`, at && `마지막 수집 ${at}`));
    return;
  }

  const ceiling = Math.min(items.length, SHOWHN_CAP);
  const visible = items.slice(0, state.feedExpanded ? ceiling : Math.min(ceiling, SHOWHN_INITIAL));
  for (const it of visible) els.list.appendChild(itemRow(it, { score: it.score || 0 }));
  if (visible.length < ceiling) {
    appendMoreButton(ceiling - visible.length);
  } else if (items.length > ceiling) {
    els.list.appendChild(h('div', { class: 'status', text: `점수순 상위 ${ceiling}건 표시 (전체 ${items.length}건)` }));
  }
}

function showhnMonthsNeeded() {
  if (!state.manifest) return [];
  const since = feedCutoffDate().slice(0, 7);
  return state.manifest.months.filter((m) => m.hasShowhn && m.key >= since).map((m) => m.key);
}

// 아카이브 항목의 score는 수집 시점 값이라 대부분 1~2점에 몰린다 (게시 직후에 잡히기 때문).
// sidecar에 최근 96시간 창의 현재 점수가 있으면 그걸 쓰고, 창 밖 항목은 얼어붙은 값으로 폴백한다.
function showhnScore(item, scores) {
  const nativeId = item.id.slice('showhn:'.length);
  const fresh = scores ? scores[nativeId] : undefined;
  return typeof fresh === 'number' ? fresh : (item.score || 0);
}

async function fetchShowhnScores(v) {
  try {
    const res = await fetch(`data/showhn-scores.json?v=${v}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadShowhn() {
  const v = encodeURIComponent(state.manifest.updatedAt);
  const scores = await fetchShowhnScores(v);
  const all = [];
  for (const key of showhnMonthsNeeded()) {
    const res = await fetch(`data/${key}.showhn.json?v=${v}`);
    if (!res.ok) continue;
    for (const it of await res.json()) all.push(it);
  }
  const since = feedCutoffDate();
  return all
    .filter((it) => it.collectedDate >= since)
    .map((it) => ({ ...it, score: showhnScore(it, scores) }))
    .sort((a, b) => b.score - a.score);
}

function chipButton(label, isOn, onClick) {
  return h('button', { class: isOn ? 'on' : '', 'aria-pressed': String(isOn), text: label, onclick: onClick });
}

function selectSource(key) {
  state.sourceFilter = key;
  state.feedExpanded = false;
  render();
}

function renderSourceChips(health) {
  els.sourceChips.textContent = '';
  els.sourceChips.appendChild(chipButton('전체', state.sourceFilter === null, () => selectSource(null)));
  for (const [key, label] of Object.entries(SOURCES)) {
    const chip = chipButton(label, state.sourceFilter === key, () => selectSource(state.sourceFilter === key ? null : key));
    if (health.stalled.has(key)) {
      chip.dataset.state = 'stalled';
      chip.title = `${label} 수집이 멈춰 있습니다`;
    }
    els.sourceChips.appendChild(chip);
  }
}

function renderDayChips() {
  els.dayChips.hidden = false;
  els.dayChips.textContent = '';
  for (const [value, label] of FEED_DAYS) {
    els.dayChips.appendChild(chipButton(label, state.feedDays === value, () => {
      state.feedDays = value;
      state.feedExpanded = false;
      state.showhnItems = null;
      lsSet(LS_DAYS, value);
      render();
    }));
  }
}

function renderSearchChips() {
  els.dayChips.hidden = true;
  els.periodChips.hidden = false;
  els.periodChips.textContent = '';
  for (const [value, label] of SEARCH_PERIODS) {
    els.periodChips.appendChild(chipButton(label, state.searchPeriod === value, () => {
      state.searchPeriod = value;
      syncSearchPlaceholder();
      render();
    }));
  }
}

// 검색어를 지운 뒤에도 고른 검색 기간이 이어지므로 placeholder가 그 기간을 말해야 한다.
function syncSearchPlaceholder() {
  const label = state.searchPeriod === 'all' ? '전체 기간' : `최근 ${state.searchPeriod}개월`;
  els.q.placeholder = `검색 — 제목·한줄설명 (${label})`;
}

function searchShardList(period) {
  if (!state.manifest) return [];
  const months = [...state.manifest.months].sort((a, b) => (a.key < b.key ? 1 : -1));
  let filtered = months;
  if (period !== 'all') {
    const n = Number(period);
    const cutoff = new Date(Date.parse(state.manifest.updatedAt) - n * 31 * 24 * 3600 * 1000).toISOString().slice(0, 7);
    filtered = months.filter((m) => m.key >= cutoff);
  }
  // Show HN 샤드는 나머지 전체의 5배라 Show HN 칩을 골랐을 때만 읽는다.
  const showhnOnly = state.sourceFilter === 'showhn';
  const shards = [];
  for (const m of filtered) {
    if (!showhnOnly) shards.push(`data/${m.key}.json`);
    else if (m.hasShowhn) shards.push(`data/${m.key}.showhn.json`);
  }
  return shards;
}

// 설명에서만 걸린 검색어가 2줄 클램프에 가려지면 결과가 왜 나왔는지 안 보인다. 그 행만 설명을 펼친다.
// 측정을 먼저 다 하고 클래스는 나중에 붙여 레이아웃을 한 번만 계산하게 한다.
function revealHiddenMatches(rows) {
  const hidden = [];
  for (const row of rows) {
    const d = row.querySelector('.d');
    const marks = d ? d.querySelectorAll('mark') : [];
    if (marks.length === 0) continue;
    if (marks[marks.length - 1].getBoundingClientRect().bottom > d.getBoundingClientRect().bottom + 1) hidden.push(d);
  }
  for (const d of hidden) d.classList.add('full');
}

async function runSearch() {
  renderSearchChips();
  const terms = searchTerms(state.query);
  const seq = ++state.searchSeq;
  els.list.textContent = '';
  els.footNote.textContent = '';
  // 첫 방문에 manifest보다 검색이 먼저 온 경우다. refresh()가 데이터를 받으면 검색을 다시 돌린다.
  if (!state.manifest) {
    els.countLine.textContent = '데이터 불러오는 중…';
    return;
  }

  const shards = searchShardList(state.searchPeriod);
  // 월 샤드는 두 개씩 동시에 받지만 결과는 최신 월부터 붙인다. 뒷 달이 먼저 끝나면 앞 달을 기다린다 —
  // 그래야 표시 상한(SEARCH_CAP)이 최신 결과부터 차고, 행이 전부 #list의 형제라 구분선이 끊기지 않는다.
  const found = new Array(shards.length);
  let released = 0;
  let shown = 0;
  let matched = 0;
  let failed = 0;
  let done = 0;
  let next = 0;
  const release = () => {
    const rows = [];
    for (; released < shards.length && found[released] !== undefined; released++) {
      for (const it of found[released]) {
        if (shown >= SEARCH_CAP) break;
        const row = itemRow(it, { showDate: true, terms });
        els.list.appendChild(row);
        rows.push(row);
        shown++;
      }
      found[released] = null;
    }
    revealHiddenMatches(rows);
  };
  els.countLine.textContent = `검색 중… 0/${shards.length}개월`;

  const worker = async () => {
    while (next < shards.length) {
      if (seq !== state.searchSeq) return;
      const idx = next++;
      const hits = [];
      try {
        const res = await fetch(`${shards[idx]}?v=${encodeURIComponent(state.manifest.updatedAt)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items = await res.json();
        if (seq !== state.searchSeq) return;
        for (const it of items) {
          if (state.sourceFilter !== null && it.source !== state.sourceFilter) continue;
          const text = `${it.title}\n${it.description}`.toLowerCase();
          if (terms.every((t) => text.includes(t))) hits.push(it);
        }
        hits.sort(byNewest);
      } catch {
        if (seq !== state.searchSeq) return;
        failed++;
      }
      matched += hits.length;
      found[idx] = hits;
      done++;
      release();
      els.countLine.textContent = `검색 중… ${done}/${shards.length}개월 · ${matched}건`;
    }
  };
  await Promise.all([worker(), worker()]);
  if (seq !== state.searchSeq) return;

  // 0건과 불러오기 실패는 다른 문제다. 못 받은 달이 있으면 건수 줄에 남긴다. '전체'는 Show HN을
  // 읽지 않으므로(6.3) 범위에 그렇게 적는다 — 안 적으면 Show HN 항목을 찾다가 "없음"을 믿게 된다.
  const failNote = failed > 0 ? ` · ${failed}개월 불러오지 못함` : '';
  const capNote = matched > SEARCH_CAP ? ` · ${SEARCH_CAP}건까지 표시` : '';
  const scopeNote = state.sourceFilter === null ? ' · Show HN 제외' : '';
  els.countLine.textContent = `검색 결과 ${matched}건${capNote} · ${shards.length}개월치${scopeNote}${failNote}`;
  if (matched > 0) return;
  if (shards.length > 0 && failed === shards.length) {
    const note = emptyNote('검색 데이터를 불러오지 못했습니다', '네트워크를 확인하고 다시 시도하세요');
    note.appendChild(retryButton(() => render()));
    els.list.appendChild(note);
    return;
  }
  const wider = state.searchPeriod !== 'all' && searchShardList('all').length > shards.length;
  els.list.appendChild(emptyNote(
    `"${state.query}"에 해당하는 항목 없음`,
    wider && '기간을 전체 기간으로 넓혀 보세요',
    state.sourceFilter === null && 'Show HN 항목은 Show HN 칩을 고른 뒤 검색하세요',
  ));
}

// 배너와 소스 칩은 manifest와 지금 시각만으로 정해진다. 목록을 다시 그리지 않고 이것만 갱신할 때가 있다.
function renderChrome() {
  const health = sourceHealth();
  renderBanner();
  renderSourceBanner(health);
  renderSourceChips(health);
}

function render() {
  renderChrome();
  if (state.query) runSearch();
  else renderFeed();
}

function currentTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncTheme() {
  const theme = currentTheme();
  const dark = theme === 'dark';
  // U+FE0E: iOS가 ☀를 컬러 이모지로 그리지 않게 텍스트 표현을 요청한다
  els.themeToggle.textContent = dark ? '☀\uFE0E' : '☾';
  els.themeToggle.title = dark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기';
  els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
  const forced = document.documentElement.dataset.theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const metaDark = forced ? forced === 'dark' : m.media.includes('dark');
    m.content = metaDark ? '#171717' : '#eff3f3';
  });
}

// 시스템과 같은 쪽으로 돌아오면 고정을 풀어 다시 시스템 설정을 따르게 한다. 한 번 누른 뒤로
// 다시는 시스템 전환(해 질 녘 자동 다크 등)을 따르지 않던 문제를 막는다.
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (next === system) {
    delete document.documentElement.dataset.theme;
    lsRemove(LS_THEME);
  } else {
    document.documentElement.dataset.theme = next;
    lsSet(LS_THEME, next);
  }
  syncTheme();
}

function restoreScroll() {
  const y = Number(ssGet(SS_SCROLL) || 0);
  if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
}

// 새 데이터로 다시 그릴 때 픽셀 위치를 되돌리면 위에 끼어든 새 항목만큼 다른 행에 착지한다.
// 목록 안을 읽던 중이면 화면 맨 위에 걸친 행을 기억했다가 그 행이 같은 자리에 오게 맞춘다.
// 헤더가 보이는 위치(목록 위쪽)였다면 기억하지 않는다 — 새 항목이 위에 보여야 한다.
function visibleAnchor() {
  if (state.query || els.list.getBoundingClientRect().top >= 0) return null;
  for (const w of els.list.querySelectorAll('.item-wrap')) {
    const r = w.getBoundingClientRect();
    if (r.bottom > 0) return { id: w.dataset.id, top: r.top };
  }
  return null;
}

function restoreAnchor(anchor) {
  if (!anchor) return false;
  const el = [...els.list.querySelectorAll('.item-wrap')].find((w) => w.dataset.id === anchor.id);
  if (!el) return false;
  window.scrollBy(0, el.getBoundingClientRect().top - anchor.top);
  return true;
}

let lastRefreshAt = 0;
let refreshing = null;

function refresh() {
  if (!refreshing) refreshing = syncData().finally(() => { refreshing = null; });
  return refreshing;
}

async function syncData() {
  lastRefreshAt = Date.now();
  try {
    // manifest는 2KB라 매번 새로 받는다. latest.json은 manifest.updatedAt으로 버전을 매겨
    // 데이터가 안 바뀐 재방문에서 브라우저 캐시를 타게 한다 — 첫 페인트는 이미 localStorage가 담당한다.
    const mRes = await fetch(`data/manifest.json?v=${Date.now()}`);
    if (!mRes.ok) throw new Error('manifest fetch failed');
    const manifest = await mRes.json();
    // updatedAt이 같으면 latest.json도 같다 — 같은 실행이 manifest와 함께 쓴다(SPEC 2.4).
    // 그때는 다시 받지도, 캐시를 다시 쓰지도 않는다.
    const changed = !state.manifest || state.manifest.updatedAt !== manifest.updatedAt;
    if (changed) {
      const lRes = await fetch(`data/latest.json?v=${encodeURIComponent(manifest.updatedAt)}`);
      if (!lRes.ok) throw new Error('latest fetch failed');
      state.items = await lRes.json();
      state.showhnItems = null;
      lsSet(LS_CACHE, JSON.stringify({ manifest, items: state.items }));
    }
    state.manifest = manifest;
    state.checked = true;
    state.offline = false;
    // 검색 중인데 데이터가 그대로면 결과를 다시 받지 않는다 — 읽던 결과 목록과 스크롤을 지킨다.
    if (changed || !state.query) {
      const anchor = changed ? visibleAnchor() : null;
      render();
      if (!restoreAnchor(anchor)) restoreScroll();
    } else {
      renderChrome();
    }
  } catch {
    state.offline = true;
    if (state.manifest) {
      renderChrome();
      return;
    }
    els.list.textContent = '';
    const note = emptyNote('데이터를 불러오지 못했습니다', '네트워크를 확인하고 다시 시도하세요');
    note.appendChild(retryButton(() => {
      els.list.textContent = '';
      els.list.appendChild(emptyNote('데이터 불러오는 중…'));
      refresh();
    }));
    els.list.appendChild(note);
  }
}

function applyQuery() {
  const q = els.q.value.trim();
  if (q === state.query) return;
  state.query = q;
  state.searchSeq++;
  state.feedExpanded = false;
  render();
}

function init() {
  history.scrollRestoration = 'manual';

  const savedDays = lsGet(LS_DAYS);
  if (savedDays && FEED_DAYS.some(([value]) => value === savedDays)) state.feedDays = savedDays;

  const cached = lsGet(LS_CACHE);
  if (cached) {
    try {
      const { manifest, items } = JSON.parse(cached);
      if (!manifest || !manifest.updatedAt || !Array.isArray(items)) throw new Error('bad cache');
      state.manifest = manifest;
      state.items = items;
      render();
      restoreScroll();
    } catch {
      state.manifest = null;
      state.items = [];
    }
  }
  // 캐시가 없어도 칩과 '불러오는 중'을 먼저 그린다. 헤더만 덩그러니 있으면 고장으로 읽힌다 (SPEC 6.4).
  if (!state.manifest) render();

  document.getElementById('brand').addEventListener('click', () => {
    ssSet(SS_SCROLL, '0');
  });
  els.themeToggle.addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
  syncTheme();

  let debounce = null;
  els.q.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(applyQuery, 300);
  });
  // Enter(폰 키보드의 '검색')는 폼 제출로 받는다. 한글 조합을 끝내는 Enter에는 브라우저가 제출을
  // 걸지 않으므로 마지막 글자가 빠지지 않는다. 폰에서는 키보드를 내려 결과가 보이게 한다.
  els.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (debounce) clearTimeout(debounce);
    applyQuery();
    if (matchMedia('(pointer: coarse)').matches) els.q.blur();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefreshAt >= RESUME_REFRESH_MS) refresh();
  });
  // iOS Safari는 touchstart 리스너가 하나도 없으면 탭에 :active를 걸지 않는다 — 행·버튼의 눌림 표시가
  // 안 보인다. 아무 일도 하지 않는 passive 리스너 하나로 켠다.
  document.addEventListener('touchstart', () => {}, { passive: true });

  let scrollTick = false;
  window.addEventListener('scroll', () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      ssSet(SS_SCROLL, String(window.scrollY));
      scrollTick = false;
    });
  }, { passive: true });

  refresh();
}

init();
