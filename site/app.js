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
const LS_SEEN = 'idea-radar.lastSeenAt';
const LS_CACHE = 'idea-radar.cache';
const SS_SCROLL = 'idea-radar.scrollY';
const SS_SHOWHN = 'idea-radar.showhnOpen';
const AUTO_SEEN_MS = 120000;
const STALE_MS = 26 * 3600 * 1000;

const $ = (id) => document.getElementById(id);
const els = {
  banner: $('banner'),
  q: $('q'),
  chips: $('chips'),
  sourceChips: $('sourceChips'),
  periodChips: $('periodChips'),
  visitLine: $('visitLine'),
  list: $('list'),
  showhnBlock: $('showhnBlock'),
  showhnToggle: $('showhnToggle'),
  showhnList: $('showhnList'),
  footNote: $('footNote'),
};

const state = {
  manifest: null,
  items: [],
  query: '',
  searchSeq: 0,
  sourceFilter: new Set(),
  searchPeriod: '12',
  searchShowhn: false,
  showhnItems: null,
};

const kstDay = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short' });
const kstTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
const kstFull = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });

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
  title.appendChild(h('span', { class: 'badge', 'data-s': item.source, text: SOURCES[item.source] || item.source }));
  title.appendChild(document.createTextNode(item.title));
  if (opts && opts.showDate) title.appendChild(h('span', { class: 'when', text: item.collectedDate }));
  if (opts && opts.score !== undefined) title.appendChild(h('span', { class: 'when', text: `${opts.score}p` }));
  const row = h('a', { class: 'row', href: item.url, target: '_blank', rel: 'noopener' }, title);
  if (item.description) row.appendChild(h('span', { class: 'd', text: item.description }));
  const wrap = h('div', { style: 'position:relative' }, row);
  if (item.externalUrl) {
    wrap.appendChild(h('a', { class: 'ext', href: item.externalUrl, target: '_blank', rel: 'noopener', title: '제품 사이트 열기', text: '↗' }));
  }
  return wrap;
}

function maxCollectedAt() {
  let max = '';
  for (const it of state.items) if (it.collectedAt > max) max = it.collectedAt;
  return max;
}

function sinceCutoff() {
  const seen = lsGet(LS_SEEN);
  if (seen) return seen;
  const base = state.manifest ? Date.parse(state.manifest.updatedAt) : Date.now();
  return new Date(base - 24 * 3600 * 1000).toISOString();
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

function renderVisitLine(total, shown) {
  const seen = lsGet(LS_SEEN);
  const filterNote = shown !== total ? ` · 표시 ${shown}건` : '';
  if (!seen) {
    els.visitLine.textContent = `처음 방문 · 최근 1일 새 항목 ${total}건${filterNote}`;
    return;
  }
  const days = (Date.now() - Date.parse(seen)) / (24 * 3600 * 1000);
  const ago = days < 1 ? '오늘 다시 방문' : `${Math.round(days)}일 만에 방문`;
  els.visitLine.textContent = `${ago} · 새 항목 ${total}건${filterNote}`;
}

function renderFeed() {
  els.chips.hidden = true;
  els.list.textContent = '';
  const since = sinceCutoff();
  const all = state.items.filter((it) => it.collectedAt > since).sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1));
  const fresh = state.sourceFilter.size === 0 ? all : all.filter((it) => state.sourceFilter.has(it.source));
  renderVisitLine(all.length, fresh.length);

  if (fresh.length === 0) {
    const at = state.manifest ? kstTime.format(new Date(state.manifest.updatedAt)) : '';
    const msg = state.sourceFilter.size > 0 && all.length > 0
      ? '선택한 소스에 새 항목 없음'
      : at ? `오늘 ${at} 기준 새 항목 없음` : '데이터 로딩 중…';
    els.list.appendChild(h('div', { class: 'empty', text: msg }));
  } else {
    let currentDate = '';
    for (const it of fresh) {
      if (it.collectedDate !== currentDate) {
        currentDate = it.collectedDate;
        const label = kstDay.format(new Date(currentDate + 'T12:00:00+09:00'));
        const count = fresh.filter((x) => x.collectedDate === currentDate).length;
        els.list.appendChild(h('div', { class: 'day-head', text: `${label} · ${count}건` }));
      }
      els.list.appendChild(itemRow(it));
    }
  }

  const oldest = state.items[0];
  if (lsGet(LS_SEEN) && oldest && lsGet(LS_SEEN) < oldest.collectedAt) {
    els.footNote.textContent = '30일 이전 항목은 검색으로 찾을 수 있습니다';
  } else {
    els.footNote.textContent = '';
  }
  els.showhnBlock.hidden = false
  renderShowhn();
}

function showhnMonthsNeeded() {
  if (!state.manifest) return [];
  const since = sinceCutoff().slice(0, 7);
  return state.manifest.months.filter((m) => m.hasShowhn && m.key >= since).map((m) => m.key);
}

async function loadShowhn() {
  const months = showhnMonthsNeeded();
  const all = [];
  for (const key of months) {
    const res = await fetch(`data/${key}.showhn.json?v=${encodeURIComponent(state.manifest.updatedAt)}`);
    if (!res.ok) continue;
    for (const it of await res.json()) all.push(it);
  }
  const since = sinceCutoff();
  return all.filter((it) => it.collectedAt > since).sort((a, b) => (b.score || 0) - (a.score || 0));
}

function renderShowhnItems(expandAll) {
  const items = state.showhnItems || [];
  els.showhnList.textContent = '';
  els.showhnList.hidden = false;
  if (items.length === 0) {
    els.showhnList.appendChild(h('div', { class: 'empty', text: '지난 방문 이후 Show HN 새 항목 없음' }));
    return;
  }
  const top = expandAll ? items : items.slice(0, 15);
  for (const it of top) els.showhnList.appendChild(itemRow(it, { score: it.score || 0 }));
  if (!expandAll && items.length > 15) {
    els.showhnList.appendChild(h('button', { class: 'more-btn', text: `전체 ${items.length}건 보기`, onclick: () => renderShowhnItems(true) }));
  }
}

function renderShowhn() {
  const open = ssGet(SS_SHOWHN) === '1';
  els.showhnToggle.textContent = open ? 'Show HN 접기' : 'Show HN 펼치기';
  els.showhnToggle.classList.toggle('on', open);
  if (!open) { els.showhnList.hidden = true; return; }
  if (state.showhnItems) { renderShowhnItems(false); return; }
  els.showhnList.hidden = false;
  els.showhnList.textContent = '';
  els.showhnList.appendChild(h('div', { class: 'status', text: 'Show HN 불러오는 중…' }));
  loadShowhn().then((items) => {
    state.showhnItems = items;
    if (ssGet(SS_SHOWHN) === '1') renderShowhnItems(false);
  }).catch(() => {
    els.showhnList.textContent = '';
    els.showhnList.appendChild(h('div', { class: 'empty', text: 'Show HN 로딩 실패' }));
  });
}

function chipButton(label, isOn, onClick) {
  return h('button', { class: isOn ? 'on' : '', text: label, onclick: onClick });
}

function renderSourceChips() {
  els.sourceChips.textContent = '';
  els.sourceChips.appendChild(chipButton('전체', state.sourceFilter.size === 0, () => { state.sourceFilter.clear(); render(); }));
  for (const [key, label] of Object.entries(SOURCES)) {
    if (key === 'showhn') continue;
    els.sourceChips.appendChild(chipButton(label, state.sourceFilter.has(key), () => {
      if (state.sourceFilter.has(key)) state.sourceFilter.delete(key);
      else state.sourceFilter.add(key);
      render();
    }));
  }
}

function renderSearchChips() {
  els.chips.hidden = false;
  els.periodChips.textContent = '';
  for (const [value, label] of [['1', '1개월'], ['3', '3개월'], ['12', '12개월'], ['all', '전체 기간']]) {
    els.periodChips.appendChild(chipButton(label, state.searchPeriod === value, () => { state.searchPeriod = value; render(); }));
  }
  els.periodChips.appendChild(chipButton('Show HN 포함', state.searchShowhn, () => { state.searchShowhn = !state.searchShowhn; render(); }));
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
  const shards = [];
  for (const m of filtered) {
    shards.push(`data/${m.key}.json`);
    if (state.searchShowhn && m.hasShowhn) shards.push(`data/${m.key}.showhn.json`);
  }
  return shards;
}

async function runSearch() {
  renderSearchChips();
  const q = state.query.toLowerCase();
  const seq = ++state.searchSeq;
  els.list.textContent = '';
  els.showhnBlock.hidden = true;
  els.visitLine.textContent = '';
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
            if (state.sourceFilter.size > 0 && !state.sourceFilter.has(it.source) && !(it.source === 'showhn' && state.searchShowhn)) continue;
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
  renderBanner();
  renderSourceChips();
  if (state.query) runSearch();
  else renderFeed();
}

function scheduleAutoSeen() {
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    if (document.visibilityState !== 'visible') return;
    timer = setTimeout(() => {
      const max = maxCollectedAt();
      if (max) lsSet(LS_SEEN, max);
    }, AUTO_SEEN_MS);
  };
  document.addEventListener('visibilitychange', arm);
  arm();
}

function restoreScroll() {
  const y = Number(ssGet(SS_SCROLL) || 0);
  if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
}

async function refresh() {
  const v = Date.now();
  try {
    const [mRes, lRes] = await Promise.all([
      fetch(`data/manifest.json?v=${v}`),
      fetch(`data/latest.json?v=${v}`),
    ]);
    if (!mRes.ok || !lRes.ok) throw new Error('fetch failed');
    state.manifest = await mRes.json();
    state.items = await lRes.json();
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
    ssSet(SS_SHOWHN, '0');
  });
  els.showhnToggle.addEventListener('click', () => {
    ssSet(SS_SHOWHN, ssGet(SS_SHOWHN) === '1' ? '0' : '1');
    renderShowhn();
  });

  let debounce = null;
  els.q.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = els.q.value.trim();
      state.searchSeq++;
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

  scheduleAutoSeen();
  refresh();
}

init();
