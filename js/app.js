import { firebaseConfig, VAPID_PUBLIC_KEY } from './config.js';
import * as C from './core.js';
import { createFirebaseStore, createLocalStore } from './store.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULT_COLOR = '#6e6255';
const DEFAULT_CATEGORIES = [
  { name: '予定', color: '#3f7a5a', order: 0 },
  { name: '授業', color: '#4d6f8c', order: 1 },
  { name: 'バイト', color: '#b0683a', order: 2 },
  { name: 'プライベート', color: '#a0526b', order: 3 },
];
const TIMED_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
const ALLDAY_PRESETS = [-540, 900, 180, 2340, 9540]; // 当日9:00, 前日9:00, 前日21:00, 2日前9:00, 1週間前9:00

const today0 = C.todayKey();
const S = {
  store: null,
  user: null,
  events: [],
  cats: [],
  catMap: new Map(),
  settings: { weekStart: 0 },
  y: C.parseDate(today0).y,
  m: C.parseDate(today0).m,
  selected: today0,
};

const isWide = () => window.matchMedia('(min-width: 821px)').matches;
const isSmall = () => window.matchMedia('(max-width: 600px)').matches;

// ---------- 起動 ----------

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW登録に失敗', e));
  }
  try {
    S.store = firebaseConfig ? await createFirebaseStore(firebaseConfig) : createLocalStore();
  } catch (e) {
    console.error(e);
    $('#loading').textContent = '読み込みに失敗しました。通信環境を確認して再読み込みしてください。';
    return;
  }
  bindUI();
  S.store.onAuth(user => {
    $('#loading').hidden = true;
    if (user) {
      S.user = user;
      $('#login').hidden = true;
      $('#app').hidden = false;
      if (S.store.mode === 'local') {
        showBanner('ローカルモードで動いています（この端末のブラウザにだけ保存されます）。PC・スマホで同期するには「セットアップ手順.md」に沿って Firebase を設定してください。');
      }
      S.store.subscribe({
        events: onEvents,
        categories: onCategories,
        settings: onSettings,
        error: e => { console.error(e); toast('データの読み込みでエラーが発生しました'); },
      });
      render();
      refreshPushSubscription();
    } else {
      S.user = null;
      S.events = [];
      $('#app').hidden = true;
      $('#login').hidden = false;
    }
  });
}

function onEvents(list) {
  const out = [];
  for (const raw of list) {
    if (!raw.startDate) continue;
    const ev = C.migrateEvent(raw);
    // 古い形式で保存されている予定は、新しい形式で保存しなおす
    if ((Number(raw.v) || 0) < C.EVENT_VERSION) S.store.saveEvent(ev, onSaveError);
    out.push(ev);
  }
  S.events = out;
  render();
}

function onCategories(list) {
  S.cats = list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(b.name));
  S.catMap = new Map(S.cats.map(c => [c.id, c]));
  render();
  if ($('#settingsDialog').open) renderSettings();
}

function onSettings(st, fromCache) {
  S.settings = { weekStart: 0, ...st };
  // 初回だけ種類のサンプルを作る（サーバーの最新状態を確認してから）
  if (!fromCache && !S.settings.categoriesSeeded) {
    S.store.saveSettings({ categoriesSeeded: true }, onSaveError);
    if (!S.cats.length) DEFAULT_CATEGORIES.forEach(c => S.store.saveCategory(c, onSaveError));
  }
  render();
}

function onSaveError(e) {
  console.error(e);
  toast(e && e.code === 'permission-denied' ? '保存する権限がありません（Firestoreのルールを確認してください）' : '保存に失敗しました');
}

// ---------- 描画 ----------

function catOf(ev) { return S.catMap.get(ev.categoryId) || null; }
function colorOf(ev) { const c = catOf(ev); return (c && c.color) || DEFAULT_COLOR; }

function render() {
  if (!S.user) return;
  renderHeader();
  renderGrid();
  renderDayPanel();
}

function renderHeader() {
  $('#monthLabel').textContent = `${S.y}年${S.m}月`;
  const ws = S.settings.weekStart || 0;
  $('#dow').innerHTML = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const d = (i + ws) % 7;
    return `<div class="${d === 0 ? 'sun' : d === 6 ? 'sat' : ''}">${C.WEEKDAYS[d]}</div>`;
  }).join('');
}

function gridRange() {
  const first = `${S.y}-${C.pad(S.m)}-01`;
  const off = (C.weekday(first) - (S.settings.weekStart || 0) + 7) % 7;
  const start = C.addDays(first, -off);
  const weeks = Math.ceil((off + C.daysInMonth(S.y, S.m)) / 7);
  return { start, end: C.addDays(start, weeks * 7 - 1), weeks };
}

const isBar = occ => occ.allDay || occ.startDate !== C.lastDisplayDay(occ);

function sortOccs(a, b) {
  const ba = isBar(a), bb = isBar(b);
  if (ba !== bb) return ba ? -1 : 1;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.endMs !== b.endMs) return b.endMs - a.endMs;
  return a.ev.title.localeCompare(b.ev.title);
}

// 日付 → その日に表示する回の一覧
function occsByDay(fromKey, toKey) {
  const map = new Map();
  for (const ev of S.events) {
    for (const occ of C.occurrencesInRange(ev, fromKey, toKey)) {
      const last = C.lastDisplayDay(occ);
      for (let k = occ.startDate < fromKey ? fromKey : occ.startDate; k <= last && k <= toKey; k = C.addDays(k, 1)) {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(occ);
      }
    }
  }
  for (const list of map.values()) list.sort(sortOccs);
  return map;
}

function renderGrid() {
  const { start, end, weeks } = gridRange();
  const map = occsByDay(start, end);
  const today = C.todayKey();
  const maxItems = isSmall() ? 3 : 4;
  const ws = S.settings.weekStart || 0;
  let html = '';
  for (let i = 0; i < weeks * 7; i++) {
    const key = C.addDays(start, i);
    const { m, d } = C.parseDate(key);
    const wd = C.weekday(key);
    const cls = ['cell'];
    if (m !== S.m) cls.push('other');
    if (key === today) cls.push('today');
    if (key === S.selected) cls.push('selected');
    if (wd === 0) cls.push('sun');
    if (wd === 6) cls.push('sat');
    const list = map.get(key) || [];
    const shown = list.length > maxItems ? list.slice(0, maxItems - 1) : list;
    const items = shown.map(occ => {
      const bar = isBar(occ);
      const cont = bar && key !== occ.startDate;
      const title = esc(occ.ev.title || '(タイトルなし)');
      const time = !bar ? `<span class="t">${occ.startTime}</span>` : '';
      const label = cont && wd !== ws && !isSmall() ? '' : title;
      return `<div class="it${bar ? ' bar' : ''}${cont ? ' cont' : ''}" style="--c:${esc(colorOf(occ.ev))}" data-ev="${esc(occ.ev.id)}" data-key="${occ.key}" title="${title}">${time}${label || '&nbsp;'}</div>`;
    }).join('');
    const more = list.length > shown.length ? `<div class="more">+${list.length - shown.length}</div>` : '';
    html += `<div class="${cls.join(' ')}" data-date="${key}"><span class="num">${d}</span>${items}${more}</div>`;
  }
  const grid = $('#grid');
  grid.className = `grid rows-${weeks}`;
  grid.innerHTML = html;
}

function recurrenceText(r) {
  if (!r) return '';
  const iv = r.interval > 1 ? `${r.interval}` : '';
  const base = { daily: iv ? `${iv}日ごと` : '毎日', weekly: iv ? `${iv}週ごと` : '毎週', monthly: iv ? `${iv}か月ごと` : '毎月', yearly: iv ? `${iv}年ごと` : '毎年' }[r.freq];
  const days = r.freq === 'weekly' && r.byDay.length ? `（${r.byDay.map(d => C.WEEKDAYS[d]).join('・')}）` : '';
  return base + days + (r.until ? ` 〜${C.formatDateJa(r.until)}` : '');
}

function renderDayPanel() {
  const key = S.selected;
  const list = (occsByDay(key, key).get(key) || []);
  const items = list.map(occ => {
    const c = catOf(occ.ev);
    let time;
    if (occ.allDay) time = occ.startDate === occ.endDate ? '終日' : `終日（${C.formatDateJa(occ.startDate)}〜${C.formatDateJa(occ.endDate)}）`;
    else if (occ.startDate === occ.endDate) time = `${occ.startTime}〜${occ.endTime}`;
    else time = `${C.formatDateJa(occ.startDate)} ${occ.startTime}〜${C.formatDateJa(occ.endDate)} ${occ.endTime}`;
    const meta = [
      c ? esc(c.name) : '',
      occ.ev.recurrence ? `🔁 ${esc(recurrenceText(occ.ev.recurrence))}` : '',
      occ.ev.reminders.length ? `🔔 ${occ.ev.reminders.map(r => C.reminderLabel(r.min, occ.ev.allDay)).join('、')}` : '',
    ].filter(Boolean).map(s => `<span>${s}</span>`).join('');
    return `<button class="dp-item" style="--c:${esc(colorOf(occ.ev))}" data-ev="${esc(occ.ev.id)}" data-key="${occ.key}">
      <span class="dp-bar"></span>
      <span class="dp-main">
        <div class="dp-time">${esc(time)}</div>
        <div class="dp-title">${esc(occ.ev.title || '(タイトルなし)')}</div>
        ${meta ? `<div class="dp-meta">${meta}</div>` : ''}
        ${occ.ev.note ? `<div class="dp-note">${esc(occ.ev.note)}</div>` : ''}
      </span>
    </button>`;
  }).join('');
  $('#dayPanel').innerHTML = `
    <div class="dp-head">
      <h2>${esc(C.formatDateJa(key, true))}</h2>
      <button class="ghost" id="dpAdd">＋ 追加</button>
    </div>
    ${list.length ? `<div class="dp-list">${items}</div>` : '<div class="dp-empty">予定はありません</div>'}`;
}

// ---------- 操作 ----------

function bindUI() {
  $('#prevBtn').onclick = () => moveMonth(-1);
  $('#nextBtn').onclick = () => moveMonth(1);
  $('#todayBtn').onclick = () => { const t = C.todayKey(); S.selected = t; setMonthOf(t); };
  $('#addBtn').onclick = () => openNew(S.selected);
  $('#settingsBtn').onclick = openSettings;

  $('#grid').addEventListener('click', e => {
    const it = e.target.closest('.it');
    const cell = e.target.closest('.cell');
    if (!cell) return;
    if (it && isWide()) { openEditById(it.dataset.ev, it.dataset.key); return; }
    S.selected = cell.dataset.date;
    const { y, m } = C.parseDate(S.selected);
    if (y !== S.y || m !== S.m) { setMonthOf(S.selected); return; }
    render();
    if (!isWide()) $('#dayPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#grid').addEventListener('dblclick', e => {
    const cell = e.target.closest('.cell');
    if (cell && !e.target.closest('.it')) openNew(cell.dataset.date);
  });
  $('#dayPanel').addEventListener('click', e => {
    if (e.target.closest('#dpAdd')) { openNew(S.selected); return; }
    const it = e.target.closest('.dp-item');
    if (it) openEditById(it.dataset.ev, it.dataset.key);
  });

  // スマホ: 左右スワイプで月を移動
  let sx = null, sy = null;
  const cal = $('#calendar');
  cal.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  cal.addEventListener('touchend', e => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) moveMonth(dx < 0 ? 1 : -1);
  }, { passive: true });

  let lastSmall = isSmall();
  window.addEventListener('resize', () => { if (isSmall() !== lastSmall) { lastSmall = isSmall(); render(); } });

  // 日付が変わったら「今日」の表示を更新
  let lastToday = C.todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && C.todayKey() !== lastToday) { lastToday = C.todayKey(); render(); }
  });

  const updateNet = () => { $('#netStatus').hidden = navigator.onLine || S.store.mode === 'local'; };
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  document.querySelectorAll('dialog [data-close]').forEach(b => { b.onclick = () => b.closest('dialog').close(); });

  bindLogin();
  bindEventForm();
}

function moveMonth(delta) {
  let m = S.m + delta, y = S.y;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  S.y = y; S.m = m;
  const { y: sy, m: sm } = C.parseDate(S.selected);
  if (sy !== y || sm !== m) {
    const t = C.todayKey(); const tp = C.parseDate(t);
    S.selected = tp.y === y && tp.m === m ? t : `${y}-${C.pad(m)}-01`;
  }
  render();
}
function setMonthOf(key) { const { y, m } = C.parseDate(key); S.y = y; S.m = m; render(); }

// ---------- ログイン ----------

function bindLogin() {
  let signup = false;
  const setMode = v => {
    signup = v;
    $('#loginSubmit').textContent = v ? 'アカウントを作成' : 'ログイン';
    $('#loginLead').textContent = v ? 'メールアドレスと6文字以上のパスワードを決めてください' : 'ログインしてください';
    $('#toggleSignup').textContent = v ? 'ログインに戻る' : 'はじめて使う（アカウント作成）';
    $('#loginPw').autocomplete = v ? 'new-password' : 'current-password';
    $('#loginError').hidden = true;
  };
  $('#toggleSignup').onclick = () => setMode(!signup);
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim(), pw = $('#loginPw').value;
    $('#loginError').hidden = true;
    $('#loginSubmit').disabled = true;
    try {
      if (signup) await S.store.signUp(email, pw); else await S.store.signIn(email, pw);
    } catch (err) {
      $('#loginError').textContent = authErrorText(err);
      $('#loginError').hidden = false;
    } finally {
      $('#loginSubmit').disabled = false;
    }
  };
  $('#resetPw').onclick = async () => {
    const email = $('#loginEmail').value.trim();
    if (!email) { $('#loginError').textContent = 'メールアドレスを入力してから押してください'; $('#loginError').hidden = false; return; }
    try { await S.store.resetPassword(email); toast('パスワード再設定のメールを送りました'); }
    catch (err) { $('#loginError').textContent = authErrorText(err); $('#loginError').hidden = false; }
  };
}

function authErrorText(err) {
  const code = (err && err.code) || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'メールアドレスかパスワードが違います';
  if (code.includes('email-already-in-use')) return 'このメールアドレスはすでに登録されています';
  if (code.includes('weak-password')) return 'パスワードは6文字以上にしてください';
  if (code.includes('invalid-email')) return 'メールアドレスの形式が正しくありません';
  if (code.includes('too-many-requests')) return '試行回数が多すぎます。しばらく待ってからやり直してください';
  if (code.includes('network')) return '通信できませんでした';
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted')) return 'この操作は許可されていません（Firebaseの設定を確認してください）';
  return `エラー: ${code || err}`;
}

// ---------- 予定の追加・編集 ----------

const F = {}; // フォームの状態 { ev, key, reminders: [min] }

function bindEventForm() {
  $('#recDays').innerHTML = C.WEEKDAYS.map((w, i) => `<label><input type="checkbox" value="${i}">${w}</label>`).join('');
  $('#fAllDay').onchange = () => {
    const allDay = $('#fAllDay').checked;
    // 時間指定 ⇔ 終日 を切りかえたら、通知はそれぞれのよくある設定に置きかえる
    if (F.reminders.length) F.reminders = allDay ? [900] : [10];
    applyAllDayUI();
  };
  let prevStart = null;
  $('#fStartDate').onfocus = () => { prevStart = $('#fStartDate').value; };
  $('#fStartDate').onchange = () => {
    // 開始日を動かしたら、終了日も同じだけずらす
    const ns = $('#fStartDate').value, ps = prevStart || ns;
    if (ns && ps && $('#fEndDate').value) {
      const ne = C.addDays($('#fEndDate').value, C.diffDays(ns, ps));
      $('#fEndDate').value = ne < ns ? ns : ne;
    }
    prevStart = ns;
    syncWeekdayDefault();
  };
  let prevStartTime = null;
  $('#fStartTime').onfocus = () => { prevStartTime = $('#fStartTime').value; };
  $('#fStartTime').onchange = () => {
    const st = $('#fStartTime').value, pst = prevStartTime || st;
    if (st && pst && $('#fEndTime').value && $('#fStartDate').value === $('#fEndDate').value) {
      const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      let e = toMin($('#fEndTime').value) + (toMin(st) - toMin(pst));
      if (e >= 1440) { $('#fEndDate').value = C.addDays($('#fEndDate').value, 1); e -= 1440; }
      if (e < toMin(st) && $('#fStartDate').value === $('#fEndDate').value) e = Math.min(toMin(st) + 60, 1439);
      $('#fEndTime').value = `${C.pad(Math.floor(e / 60))}:${C.pad(e % 60)}`;
    }
    prevStartTime = st;
  };
  $('#fRecFreq').onchange = applyRecUI;
  $('#clearUntil').onclick = () => { $('#fRecUntil').value = ''; };
  $('#remAdd').onchange = onReminderSelect;
  $('#remChips').addEventListener('click', e => {
    const b = e.target.closest('button[data-min]');
    if (!b) return;
    F.reminders = F.reminders.filter(m => m !== Number(b.dataset.min));
    renderReminders();
  });
  $('#eventForm').onsubmit = e => { e.preventDefault(); saveForm(); };
  $('#deleteBtn').onclick = deleteFromForm;
}

function syncWeekdayDefault() {
  if ($('#fRecFreq').value !== 'weekly') return;
  const boxes = [...$('#recDays').querySelectorAll('input')];
  if (!boxes.some(b => b.checked) && $('#fStartDate').value) boxes[C.weekday($('#fStartDate').value)].checked = true;
}

function applyAllDayUI() {
  const allDay = $('#fAllDay').checked;
  document.querySelectorAll('#eventForm .timeonly').forEach(el => { el.hidden = allDay; });
  renderReminders();
}

function applyRecUI() {
  const f = $('#fRecFreq').value;
  $('#recDetail').hidden = f === 'none';
  $('#recDaysRow').hidden = f !== 'weekly';
  $('#recUnit').textContent = { daily: '日ごと', weekly: '週ごと', monthly: 'か月ごと', yearly: '年ごと' }[f] || '';
  syncWeekdayDefault();
}

function renderReminders() {
  const allDay = $('#fAllDay').checked;
  F.reminders = [...new Set(F.reminders)].sort((a, b) => b - a);
  $('#remChips').innerHTML = F.reminders.map(m =>
    `<span class="chip">${esc(C.reminderLabel(m, allDay))}<button type="button" data-min="${m}" aria-label="削除">×</button></span>`).join('');
  const presets = (allDay ? ALLDAY_PRESETS : TIMED_PRESETS).filter(m => !F.reminders.includes(m));
  $('#remAdd').innerHTML = `<option value="">${F.reminders.length ? '＋ 通知を追加' : '＋ 通知を追加（なし）'}</option>` +
    presets.map(m => `<option value="${m}">${esc(C.reminderLabel(m, allDay))}</option>`).join('') +
    '<option value="custom">カスタム…</option>';
  $('#remCustom').hidden = true;
}

function onReminderSelect() {
  const v = $('#remAdd').value;
  if (v === '') return;
  if (v !== 'custom') { F.reminders.push(Number(v)); renderReminders(); return; }
  const allDay = $('#fAllDay').checked;
  const box = $('#remCustom');
  box.innerHTML = allDay
    ? `<input type="number" id="rcDays" min="0" max="365" value="1"> 日前の <input type="time" id="rcTime" value="09:00"> <button type="button" class="ghost" id="rcOk">追加</button>`
    : `<input type="number" id="rcNum" min="0" max="9999" value="20"> <select id="rcUnit"><option value="1">分</option><option value="60">時間</option><option value="1440">日</option><option value="10080">週間</option></select> 前 <button type="button" class="ghost" id="rcOk">追加</button>`;
  box.hidden = false;
  $('#rcOk').onclick = () => {
    let min;
    if (allDay) {
      const d = parseInt($('#rcDays').value, 10), t = $('#rcTime').value;
      if (!(d >= 0) || !t) return;
      min = C.allDayReminderToMin(d, t);
    } else {
      const n = parseInt($('#rcNum').value, 10);
      if (!(n >= 0)) return;
      min = n * Number($('#rcUnit').value);
    }
    F.reminders.push(min);
    renderReminders();
  };
}

function fillCategorySelect(selectedId) {
  const opts = S.cats.map(c => `<option value="${esc(c.id)}" style="color:${esc(c.color)}">${esc(c.name)}</option>`).join('');
  $('#fCategory').innerHTML = `<option value="">（なし）</option>${opts}`;
  $('#fCategory').value = selectedId && S.catMap.has(selectedId) ? selectedId : '';
}

function fillForm(v) {
  $('#fTitle').value = v.title || '';
  fillCategorySelect(v.categoryId);
  $('#fAllDay').checked = !!v.allDay;
  $('#fStartDate').value = v.startDate;
  $('#fStartTime').value = v.startTime || '10:00';
  $('#fEndDate').value = v.endDate || v.startDate;
  $('#fEndTime').value = v.endTime || '11:00';
  const r = v.recurrence;
  $('#fRecFreq').value = r ? r.freq : 'none';
  $('#fRecInterval').value = r ? r.interval : 1;
  $('#fRecUntil').value = (r && r.until) || '';
  $('#recDays').querySelectorAll('input').forEach(b => { b.checked = !!(r && r.byDay && r.byDay.includes(Number(b.value))); });
  $('#fNote').value = v.note || '';
  F.reminders = (v.reminders || []).map(x => x.min);
  applyAllDayUI();
  applyRecUI();
}

function openNew(dateKey) {
  F.ev = null; F.key = null;
  const now = C.fromMs(Date.now());
  let h = 10;
  if (dateKey === now.date) h = Math.min(23, Number(now.time.slice(0, 2)) + 1);
  const st = `${C.pad(h)}:00`, et = h === 23 ? '23:59' : `${C.pad(h + 1)}:00`;
  const lastCat = S.settings.lastCategoryId && S.catMap.has(S.settings.lastCategoryId) ? S.settings.lastCategoryId : (S.cats[0] && S.cats[0].id);
  fillForm({ title: '', categoryId: lastCat, allDay: false, startDate: dateKey, startTime: st, endDate: dateKey, endTime: et, recurrence: null, reminders: [], note: '' });
  $('#eventDialogTitle').textContent = '予定を追加';
  $('#deleteBtn').hidden = true;
  $('#eventDialog').showModal();
  if (isWide()) $('#fTitle').focus();
}

function openEditById(id, key) {
  const ev = S.events.find(e => e.id === id);
  if (!ev) return;
  const occ = C.makeOcc(ev, key || ev.startDate);
  F.ev = ev; F.key = occ.key;
  fillForm({ ...ev, startDate: occ.startDate, endDate: occ.endDate, startTime: ev.startTime, endTime: ev.allDay ? ev.endTime : occ.endTime });
  $('#eventDialogTitle').textContent = '予定を編集';
  $('#deleteBtn').hidden = false;
  $('#eventDialog').showModal();
}

function readForm() {
  const allDay = $('#fAllDay').checked;
  const freq = $('#fRecFreq').value;
  let recurrence = null;
  if (freq !== 'none') {
    recurrence = {
      freq,
      interval: Math.max(1, parseInt($('#fRecInterval').value, 10) || 1),
      byDay: freq === 'weekly' ? [...$('#recDays').querySelectorAll('input:checked')].map(b => Number(b.value)) : [],
      until: $('#fRecUntil').value || null,
    };
  }
  return {
    title: $('#fTitle').value.trim(),
    categoryId: $('#fCategory').value || null,
    allDay,
    startDate: $('#fStartDate').value,
    startTime: $('#fStartTime').value || '00:00',
    endDate: $('#fEndDate').value,
    endTime: $('#fEndTime').value || '00:00',
    recurrence,
    reminders: F.reminders.map(min => ({ min })),
    note: $('#fNote').value,
  };
}

function validate(f) {
  if (!f.title) return 'タイトルを入力してください';
  if (!f.startDate || !f.endDate) return '日付を入力してください';
  if (f.endDate < f.startDate) return '終了日が開始日より前になっています';
  if (!f.allDay && f.endDate === f.startDate && f.endTime < f.startTime) return '終了時刻が開始時刻より前になっています';
  if (f.recurrence && f.recurrence.until && f.recurrence.until < f.startDate) return '繰り返しの終了日が開始日より前になっています';
  return null;
}

function askScope(title) {
  return new Promise(resolve => {
    const dlg = $('#scopeDialog');
    $('#scopeTitle').textContent = title;
    let result = '';
    dlg.querySelectorAll('[data-scope]').forEach(b => { b.onclick = () => { result = b.dataset.scope; dlg.close(); }; });
    dlg.onclose = () => resolve(result || null);
    dlg.showModal();
  });
}

const save = ev => S.store.saveEvent(ev, onSaveError);

async function saveForm() {
  const f = readForm();
  const err = validate(f);
  if (err) { toast(err); return; }
  if (f.categoryId && f.categoryId !== S.settings.lastCategoryId) S.store.saveSettings({ lastCategoryId: f.categoryId }, onSaveError);

  const ev = F.ev;
  if (!ev) {
    save({ ...f, exdates: [] });
    $('#eventDialog').close();
    toast('予定を追加しました');
    return;
  }
  if (!C.isRecurring(ev)) {
    save({ ...ev, ...f });
    $('#eventDialog').close();
    toast('保存しました');
    return;
  }
  const scope = await askScope('どの予定を変更しますか？');
  if (!scope) return;
  const key = F.key;
  if (scope === 'one') {
    save({ ...ev, exdates: [...ev.exdates, key] });
    save({ ...f, recurrence: null, exdates: [] });
  } else if (scope === 'future' && key !== ev.startDate) {
    save({ ...ev, recurrence: { ...ev.recurrence, until: C.addDays(key, -1) } });
    save({ ...f, exdates: ev.exdates.filter(d => d >= key) });
  } else {
    // すべて: 表示中の回でずらした日数を、最初の回にも反映する
    const delta = C.diffDays(f.startDate, key);
    const len = C.diffDays(f.endDate, f.startDate);
    const startDate = C.addDays(ev.startDate, delta);
    save({ ...ev, ...f, startDate, endDate: C.addDays(startDate, len), exdates: ev.exdates.map(d => C.addDays(d, delta)) });
  }
  $('#eventDialog').close();
  toast('保存しました');
}

async function deleteFromForm() {
  const ev = F.ev;
  if (!ev) return;
  if (!C.isRecurring(ev)) {
    if (!confirm(`「${ev.title}」を削除しますか？`)) return;
    S.store.deleteEvent(ev.id, onSaveError);
  } else {
    const scope = await askScope('どの予定を削除しますか？');
    if (!scope) return;
    const key = F.key;
    if (scope === 'one') save({ ...ev, exdates: [...ev.exdates, key] });
    else if (scope === 'future' && key !== ev.startDate) save({ ...ev, recurrence: { ...ev.recurrence, until: C.addDays(key, -1) } });
    else S.store.deleteEvent(ev.id, onSaveError);
  }
  $('#eventDialog').close();
  toast('削除しました');
}

// ---------- 設定 ----------

function openSettings() {
  renderSettings();
  $('#settingsDialog').showModal();
}

function renderSettings() {
  const body = $('#settingsBody');
  const local = S.store.mode === 'local';
  body.innerHTML = `
    <section class="set-sec">
      <h3>アカウント</h3>
      <p>${esc(S.user.email)}</p>
      ${local ? '' : '<div class="btn-row"><button class="ghost" id="logoutBtn">ログアウト</button></div>'}
    </section>
    <section class="set-sec">
      <h3>通知（この端末）</h3>
      <div id="pushArea"><p class="muted">確認中…</p></div>
    </section>
    <section class="set-sec">
      <h3>予定の種類と文字の色</h3>
      <div id="catList" class="stack"></div>
      <div class="btn-row"><button class="ghost" id="addCat">＋ 種類を追加</button></div>
    </section>
    <section class="set-sec">
      <h3>表示</h3>
      <div class="row"><span class="lbl">週の始まり</span>
        <select id="weekStartSel"><option value="0">日曜日</option><option value="1">月曜日</option></select></div>
    </section>
    <section class="set-sec">
      <h3>バックアップ</h3>
      <p class="muted">予定と種類をファイルに書き出したり、書き出したファイルから戻したりできます。</p>
      <div class="btn-row">
        <button class="ghost" id="exportBtn">書き出す</button>
        <button class="ghost" id="importBtn">ファイルから読み込む</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
    </section>`;

  if (!local) $('#logoutBtn').onclick = async () => { $('#settingsDialog').close(); await S.store.signOut(); };

  renderCatList();
  $('#addCat').onclick = () => {
    S.store.saveCategory({ name: '新しい種類', color: '#3f7a5a', order: (S.cats.at(-1)?.order ?? 0) + 1 }, onSaveError);
  };

  $('#weekStartSel').value = String(S.settings.weekStart || 0);
  $('#weekStartSel').onchange = e => { S.store.saveSettings({ weekStart: Number(e.target.value) }, onSaveError); };

  $('#exportBtn').onclick = exportData;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = importData;

  renderPushArea();
}

function renderCatList() {
  const list = $('#catList');
  if (!list) return;
  list.innerHTML = S.cats.length ? S.cats.map(c => `
    <div class="cat-row" data-id="${esc(c.id)}">
      <input type="color" value="${esc(c.color)}" list="palette" aria-label="文字の色">
      <input type="text" value="${esc(c.name)}" style="color:${esc(c.color)}" aria-label="種類の名前">
      <button class="icon-btn" data-del aria-label="削除">🗑</button>
    </div>`).join('') : '<p class="muted">種類がありません</p>';
  list.querySelectorAll('.cat-row').forEach(row => {
    const cat = S.catMap.get(row.dataset.id);
    const [color, name] = row.querySelectorAll('input');
    color.oninput = () => { name.style.color = color.value; };
    color.onchange = () => S.store.saveCategory({ ...cat, color: color.value }, onSaveError);
    name.onchange = () => S.store.saveCategory({ ...cat, name: name.value.trim() || cat.name }, onSaveError);
    row.querySelector('[data-del]').onclick = () => {
      const used = S.events.filter(e => e.categoryId === cat.id).length;
      if (!confirm(`種類「${cat.name}」を削除しますか？${used ? `\n（この種類の予定${used}件は「なし」の扱いになります）` : ''}`)) return;
      S.store.deleteCategory(cat.id, onSaveError);
    };
  });
}

function exportData() {
  const strip = ({ id, ...rest }) => ({ id, ...rest });
  const data = {
    app: 'my-schedule', exportedAt: new Date().toISOString(), eventVersion: C.EVENT_VERSION,
    events: S.events.map(strip), categories: S.cats.map(strip), settings: S.settings,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `schedule-backup-${C.todayKey().replaceAll('-', '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('ファイルを読めませんでした'); return; }
  if (!data || data.app !== 'my-schedule' || !Array.isArray(data.events)) { toast('このアプリのバックアップファイルではありません'); return; }
  if (!confirm(`予定${data.events.length}件・種類${(data.categories || []).length}件を読み込みます。\n同じ予定がある場合は上書きされます。よろしいですか？`)) return;
  (data.categories || []).forEach(c => S.store.saveCategory(c, onSaveError));
  data.events.forEach(ev => { if (ev.startDate) save(ev); });
  toast('読み込みました');
}

// ---------- 通知（Web Push） ----------

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager ? reg.pushManager.getSubscription() : null;
}

// 許可済みの端末では、起動のたびに購読情報を保存しなおす（期限切れ・変更に備えて）
async function refreshPushSubscription() {
  try {
    if (S.store.mode === 'local' || !VAPID_PUBLIC_KEY || !('Notification' in window) || Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    if (sub) await S.store.savePushSub(sub.toJSON());
  } catch (e) { console.warn(e); }
}

async function renderPushArea() {
  const area = $('#pushArea');
  const set = html => { area.innerHTML = html; };
  if (S.store.mode === 'local') return set('<p class="muted">ローカルモードでは使えません。Firebase の設定後に使えるようになります。</p>');
  if (!VAPID_PUBLIC_KEY) return set('<p class="muted">通知用の鍵（VAPID_PUBLIC_KEY）が js/config.js に設定されていません。</p>');
  if (isIOS() && !isStandalone()) return set('<p>iPhone では、Safari の共有ボタン →「ホーム画面に追加」で追加したアプリから開いて、ここで通知をオンにしてください。</p>');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return set('<p class="muted">このブラウザは通知に対応していません。</p>');
  if (Notification.permission === 'denied') return set('<p>通知がブロックされています。端末（ブラウザ）の設定でこのアプリの通知を許可してください。</p>');

  let sub = null;
  try { sub = await currentSubscription(); } catch { /* なし */ }
  if (Notification.permission === 'granted' && sub) {
    set(`<p>✅ この端末は通知を受け取ります。</p>
      <p class="muted">通知は約5分ごとの確認で送られるため、数分〜十数分遅れることがあります。</p>
      <div class="btn-row"><button class="ghost" id="testPush">この端末でテスト表示</button><button class="ghost" id="unsubPush">この端末の通知をオフ</button></div>`);
    $('#testPush').onclick = async () => {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification('テスト通知', { body: '通知はこのように表示されます', icon: './icons/icon-192.png', tag: 'test' });
    };
    $('#unsubPush').onclick = async () => { await sub.unsubscribe(); toast('この端末の通知をオフにしました'); renderPushArea(); };
    return;
  }
  set(`<p>予定ごとに設定した通知を、この端末で受け取れるようにします。</p>
    <div class="btn-row"><button class="primary" id="enablePush">この端末で通知を受け取る</button></div>`);
  $('#enablePush').onclick = enablePush;
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderPushArea(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
    await S.store.savePushSub(sub.toJSON());
    toast('通知をオンにしました');
  } catch (e) {
    console.error(e);
    toast(`通知をオンにできませんでした: ${e.message || e}`);
  }
  renderPushArea();
}

// ---------- 小物 ----------

function showBanner(text) { const b = $('#banner'); b.textContent = text; b.hidden = false; }

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

init();
