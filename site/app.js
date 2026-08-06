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
const FEED_DAYS = [['1', '1일'], ['3', '3일'], ['7', '7일'], ['30', '30일']];
const FEED_CAP = 300;
const SHOWHN_INITIAL = 30;
const SHOWHN_CAP = 200;

const $ = (id) => document.getElementById(id);
const els = {
  banner: $('banner'),
  sourceBanner: $('sourceBanner'),
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
};

const kstDay = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });
const kstFull = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
const kstISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
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

function itemRow(item, opts) {
  const title = h('span', { class: 't' });
  title.appendChild(h('span', { class: 'badge', text: SOURCES[item.source] || item.source }));
  title.appendChild(document.createTextNode(item.title));
  if (opts && opts.showDate) title.appendChild(h('span', { class: 'when', text: item.collectedDate }));
  if (opts && opts.score !== undefined) title.appendChild(h('span', { class: 'when', text: `${opts.score}p` }));
  const row = h('a', { class: 'row', href: item.url, target: '_blank', rel: 'noopener' }, title);
  if (item.description) row.appendChild(h('span', { class: 'd', text: item.description }));
  const wrap = h('div', { class: 'item-wrap' }, row);
  if (item.externalUrl) {
    wrap.appendChild(h('a', { class: 'ext', href: item.externalUrl, target: '_blank', rel: 'noopener', title: '제품 사이트 열기', text: '↗' }));
  }
  return wrap;
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

function lastCollectedNote() {
  return state.manifest ? `${kstFull.format(new Date(state.manifest.updatedAt))} KST` : '';
}

function renderBanner() {
  const m = state.manifest;
  if (!m) { els.banner.hidden = true; return; }
  const age = Date.now() - Date.parse(m.updatedAt);
  if (age > STALE_MS) {
    const days = Math.max(1, Math.floor(age / (24 * 3600 * 1000)));
    els.banner.textContent = `수집이 ${days}일째 멈춤 (마지막 성공 ${kstFull.format(new Date(m.updatedAt))} KST)`;
    els.banner.hidden = false;
  } else {
    els.banner.hidden = true;
  }
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
  const sources = (state.manifest && state.manifest.sources) || {};
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

function renderSourceBanner(health) {
  const stalled = [...health.stalled].map(([key, s]) => {
    const at = s.lastSuccessAt ? `마지막 성공 ${kstFull.format(new Date(s.lastSuccessAt))} KST` : '성공 이력 없음';
    return `${SOURCES[key] || key} 수집 멈춤 · ${at}${errorNote(s)}`;
  });
  if (stalled.length > 0) {
    els.sourceBanner.textContent = stalled.join(' / ');
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
    els.sourceBanner.textContent = quiet.join(' / ');
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
  const since = feedCutoffDate();
  const all = state.items.filter((it) => it.collectedDate >= since).sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1));
  const shown = state.sourceFilter === null ? all : all.filter((it) => it.source === state.sourceFilter);
  const filterNote = shown.length !== all.length ? ` · 표시 ${shown.length}건` : '';
  els.countLine.textContent = `최근 ${feedDaysLabel()} ${all.length}건${filterNote}`;

  if (shown.length === 0) {
    const at = lastCollectedNote();
    const msg = state.sourceFilter !== null && all.length > 0
      ? '선택한 소스에 항목 없음'
      : at ? `최근 ${feedDaysLabel()} 수집된 항목 없음 · 마지막 수집 ${at}` : '데이터 로딩 중…';
    els.list.appendChild(h('div', { class: 'empty', text: msg }));
  } else {
    const visible = state.feedExpanded ? shown : shown.slice(0, FEED_CAP);
    let currentDate = '';
    for (const it of visible) {
      if (it.collectedDate !== currentDate) {
        currentDate = it.collectedDate;
        const label = kstDay.format(new Date(currentDate + 'T12:00:00+09:00'));
        const count = shown.filter((x) => x.collectedDate === currentDate).length;
        els.list.appendChild(h('div', { class: 'day-head', text: `${label} · ${count}건` }));
      }
      els.list.appendChild(itemRow(it));
    }
    appendMoreButton(shown.length - visible.length);
  }

  els.footNote.textContent = '30일 이전 항목은 검색으로 찾을 수 있습니다';
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
    els.countLine.textContent = `최근 ${feedDaysLabel()} Show HN`;
    els.list.appendChild(h('div', { class: 'status', text: 'Show HN 불러오는 중…' }));
    if (!state.showhnLoading) {
      state.showhnLoading = true;
      loadShowhn().then((items) => {
        state.showhnLoading = false;
        state.showhnItems = items;
        if (state.sourceFilter === 'showhn' && !state.query) render();
      }).catch(() => {
        state.showhnLoading = false;
        els.list.textContent = '';
        els.list.appendChild(h('div', { class: 'empty', text: 'Show HN을 불러오지 못했습니다. 새로고침하세요.' }));
      });
    }
    return;
  }

  const items = state.showhnItems;
  els.countLine.textContent = `최근 ${feedDaysLabel()} Show HN ${items.length}건`;
  if (items.length === 0) {
    const at = lastCollectedNote();
    els.list.appendChild(h('div', {
      class: 'empty',
      text: at ? `최근 ${feedDaysLabel()} Show HN 항목 없음 · 마지막 수집 ${at}` : `최근 ${feedDaysLabel()} Show HN 항목 없음`,
    }));
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
  for (const [value, label] of [['1', '1개월'], ['3', '3개월'], ['12', '12개월'], ['all', '전체 기간']]) {
    els.periodChips.appendChild(chipButton(label, state.searchPeriod === value, () => { state.searchPeriod = value; render(); }));
  }
}

function searchShardList() {
  if (!state.manifest) return [];
  const months = [...state.manifest.months].sort((a, b) => (a.key < b.key ? 1 : -1));
  let filtered = months;
  if (state.searchPeriod !== 'all') {
    const n = Number(state.searchPeriod);
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

async function runSearch() {
  renderSearchChips();
  const q = state.query.toLowerCase();
  const seq = ++state.searchSeq;
  els.list.textContent = '';
  els.countLine.textContent = '';
  els.footNote.textContent = '';
  const status = h('div', { class: 'status', text: '검색 중…' });
  const results = h('div', {});
  els.list.appendChild(status);
  els.list.appendChild(results);

  const shards = searchShardList();
  const slots = shards.map(() => h('div', {}));
  for (const slot of slots) results.appendChild(slot);
  let matched = 0;
  let done = 0;
  let next = 0;

  const worker = async () => {
    while (next < shards.length) {
      if (seq !== state.searchSeq) return;
      const idx = next++;
      try {
        const res = await fetch(`${shards[idx]}?v=${encodeURIComponent(state.manifest.updatedAt)}`);
        if (res.ok) {
          const items = await res.json();
          if (seq !== state.searchSeq) return;
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            if (state.sourceFilter !== null && it.source !== state.sourceFilter) continue;
            if (!(it.title.toLowerCase().includes(q) || it.description.toLowerCase().includes(q))) continue;
            matched++;
            if (matched <= 300) slots[idx].appendChild(itemRow(it, { showDate: true }));
          }
        }
      } catch {}
      done++;
      status.textContent = `${done}/${shards.length} 샤드 · 매칭 ${matched}건`;
    }
  };
  await Promise.all([worker(), worker()]);
  if (seq !== state.searchSeq) return;
  status.textContent = matched === 0 ? `"${state.query}" 매칭 없음 (${shards.length}개 샤드)` : `매칭 ${matched}건${matched > 300 ? ' (300건까지 표시)' : ''}`;
}

function render() {
  const health = sourceHealth();
  renderBanner();
  renderSourceBanner(health);
  renderSourceChips(health);
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
  els.themeToggle.textContent = dark ? '☀' : '☾';
  els.themeToggle.title = dark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기';
  els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
  const color = dark ? '#171717' : '#eff3f3';
  if (document.documentElement.dataset.theme) {
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = color; });
  }
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  lsSet(LS_THEME, next);
  syncTheme();
}

function restoreScroll() {
  const y = Number(ssGet(SS_SCROLL) || 0);
  if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
}

async function refresh() {
  try {
    // manifest는 2KB라 매번 새로 받는다. latest.json은 manifest.updatedAt으로 버전을 매겨
    // 데이터가 안 바뀐 재방문에서 브라우저 캐시를 타게 한다 — 첫 페인트는 이미 localStorage가 담당한다.
    const mRes = await fetch(`data/manifest.json?v=${Date.now()}`);
    if (!mRes.ok) throw new Error('manifest fetch failed');
    const manifest = await mRes.json();
    const lRes = await fetch(`data/latest.json?v=${encodeURIComponent(manifest.updatedAt)}`);
    if (!lRes.ok) throw new Error('latest fetch failed');
    state.manifest = manifest;
    state.items = await lRes.json();
    state.showhnItems = null;
    lsSet(LS_CACHE, JSON.stringify({ manifest: state.manifest, items: state.items }));
    render();
    restoreScroll();
  } catch {
    if (!state.manifest) {
      els.list.textContent = '';
      els.list.appendChild(h('div', { class: 'empty', text: '데이터를 불러오지 못했습니다. 네트워크 확인 후 새로고침하세요.' }));
    }
  }
}

function init() {
  history.scrollRestoration = 'manual';

  const savedDays = lsGet(LS_DAYS);
  if (savedDays && FEED_DAYS.some(([value]) => value === savedDays)) state.feedDays = savedDays;

  const cached = lsGet(LS_CACHE);
  if (cached) {
    try {
      const { manifest, items } = JSON.parse(cached);
      state.manifest = manifest;
      state.items = items;
      render();
      restoreScroll();
    } catch {}
  }

  document.getElementById('brand').addEventListener('click', () => {
    ssSet(SS_SCROLL, '0');
  });
  els.themeToggle.addEventListener('click', toggleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
  syncTheme();

  let debounce = null;
  els.q.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = els.q.value.trim();
      state.searchSeq++;
      state.feedExpanded = false;
      render();
    }, 300);
  });

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
