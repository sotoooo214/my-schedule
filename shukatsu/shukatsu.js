// shukatsu.js — 就活管理（スケジュールアプリと連携する版）
// 企業・締め切りは Firebase の users/{uid}/shukatsuCompanies に保存し、
// 締め切りはスケジュールの予定（users/{uid}/events の shk_〜）として自動で追加・更新・削除する。
import { firebaseConfig } from '../js/config.js';
import * as C from '../js/core.js';
import { createFirebaseStore, newId } from '../js/store.js';
import { buildAgenda, agendaKey } from '../js/agenda.js';

const COL = 'shukatsuCompanies';
const LEGACY_KEY = 'shukatsu-v1';          // 以前の版がこのブラウザに保存していたデータ
const MIGRATED_KEY = 'shukatsu-v1-migrated';
const CAT = { id: 'shukatsu', name: '就活', color: '#8b5e3c', order: 99 };
// スケジュールに追加するときの通知の初期設定（スケジュールアプリ側で予定ごとに変更できる）
const ALLDAY_REMINDERS = [9540, 3780, 900, -540]; // 7日前・3日前・前日・当日 の 9:00
const TIMED_REMINDERS = [1440, 60];               // 1日前・1時間前

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const DOWS = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS_LABELS = { applying: '応募中', es: 'ES提出', interview: '面接中', offer: '内定', ng: 'NG' };
const DL_LABELS = { es: 'ES締切', int: '面接', other: 'その他' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let store = null;
let companies = [];
const events = new Map();     // 就活から作った予定 id → 予定
const catIds = new Set();
const ready = { companies: false, events: false, categories: false };
let reconciled = false;
let catRequested = false;

const now0 = C.todayKey();
let curYear = C.parseDate(now0).y;
let curMonth = C.parseDate(now0).m - 1;
let selectedDay = null;
let dlCount = 0;
let editingId = null;

// ---------- 起動・ログイン ----------

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('../sw.js').catch(() => {});
  if (!firebaseConfig) {
    $('loading').textContent = 'Firebase が設定されていないため使えません（js/config.js を確認してください）';
    return;
  }
  try { store = await createFirebaseStore(firebaseConfig); }
  catch (e) { console.error(e); $('loading').textContent = '読み込みに失敗しました。通信環境を確認して再読み込みしてください。'; return; }

  $('loginForm').onsubmit = async e => {
    e.preventDefault();
    $('loginErr').hidden = true;
    try { await store.signIn($('loginEmail').value.trim(), $('loginPw').value); }
    catch (err) {
      const code = err.code || '';
      $('loginErr').textContent = code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')
        ? 'メールアドレスかパスワードが違います' : `ログインできませんでした（${code || err}）`;
      $('loginErr').hidden = false;
    }
  };
  $('importFile').onchange = importFile;

  store.onAuth(user => {
    $('loading').hidden = true;
    if (!user) { $('app').hidden = true; $('login').hidden = false; return; }
    $('login').hidden = true; $('app').hidden = false;
    store.watch(COL, onCompanies, onError);
    store.watch('events', onEvents, onError);
    store.watch('categories', onCategories, onError);
    store.watch('meta', onMeta, onError);
    render();
  });

  const net = () => setSave(navigator.onLine ? '同期済み ✓' : 'オフライン（つながったら同期します）');
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
}

function onError(e) {
  console.error(e);
  toast(e && e.code === 'permission-denied' ? '権限がありません（Firestoreのルールを確認してください）' : '保存・読み込みでエラーが発生しました');
}

function onCompanies(list, fromCache) {
  companies = list.map(normalizeCompany).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!fromCache) ready.companies = true;
  setSave(navigator.onLine ? '同期済み ✓' : 'オフライン（つながったら同期します）');
  render();
  afterLoad();
}
function onEvents(list, fromCache) {
  events.clear();
  for (const ev of list) if (ev.source === 'shukatsu') events.set(ev.id, ev);
  allEvents = list.filter(ev => ev.startDate).map(C.migrateEvent);
  if (!fromCache) ready.events = true;
  afterLoad();
  updateAgenda();
}

// ショートカット用「今日・明日の予定」も、就活の締め切りを変えたらすぐ更新する
let allEvents = [];
let agendaToken = null;
let lastAgenda = '';
function onMeta(list) {
  const st = list.find(d => d.id === 'settings');
  agendaToken = (st && st.agendaToken) || null;
  updateAgenda();
}
function updateAgenda() {
  if (!agendaToken || !ready.events) return;
  const a = buildAgenda(allEvents);
  const key = `${agendaToken}\n${agendaKey(a)}`;
  if (key === lastAgenda) return;
  lastAgenda = key;
  store.putAgenda(agendaToken, a, onError);
}
function onCategories(list, fromCache) {
  catIds.clear();
  list.forEach(c => catIds.add(c.id));
  if (!fromCache) ready.categories = true;
  afterLoad();
}

// サーバーの最新データがそろったら一度だけ：以前のデータの取り込み確認と、スケジュールとの突き合わせ
function afterLoad() {
  if (reconciled || !ready.companies || !ready.events || !ready.categories) return;
  reconciled = true;
  offerLegacyImport();
  companies.forEach(syncCompany);
  const ids = new Set(companies.map(c => c.id));
  for (const ev of events.values()) if (!ids.has(ev.companyId)) store.deleteEvent(ev.id, onError);
}

function normalizeCompany(c) {
  return {
    ...c,
    name: String(c.name || ''),
    url: String(c.url || ''),
    status: STATUS_LABELS[c.status] ? c.status : 'applying',
    memo: String(c.memo || ''),
    deadlines: (Array.isArray(c.deadlines) ? c.deadlines : [])
      .filter(d => d && d.date)
      .map(d => ({ id: d.id || newId(), type: DL_LABELS[d.type] ? d.type : 'other', date: d.date, time: d.time || '', label: d.label || DL_LABELS[d.type] || 'その他' }))
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))),
  };
}

// ---------- スケジュールとの連携 ----------

const eventId = (c, d) => `shk_${c.id}_${d.id}`;
const OWNED = ['title', 'allDay', 'startDate', 'startTime', 'endDate', 'endTime'];

function deadlineEvent(c, d, existing) {
  const allDay = !d.time;
  let endDate = d.date, endTime = d.time || '00:00';
  if (!allDay) { const e = C.fromMs(C.toMs(d.date, d.time) + 60 * 60000); endDate = e.date; endTime = e.time; }
  const keepReminders = existing && !!existing.allDay === allDay && Array.isArray(existing.reminders);
  return {
    ...(existing || {}),
    id: eventId(c, d),
    title: `${c.name}：${d.label}`,
    allDay, startDate: d.date, startTime: d.time || '00:00', endDate, endTime,
    recurrence: null, exdates: [],
    // 種類・備考・通知はスケジュールアプリ側での変更を優先して残す
    categoryId: existing ? existing.categoryId : CAT.id,
    note: existing ? existing.note : c.url,
    reminders: keepReminders ? existing.reminders : (allDay ? ALLDAY_REMINDERS : TIMED_REMINDERS).map(min => ({ min })),
    source: 'shukatsu', companyId: c.id, deadlineId: d.id,
  };
}

function ensureCategory() {
  if (catRequested || catIds.has(CAT.id)) return;
  catRequested = true;
  store.saveCategory(CAT, onError);
}

function syncCompany(c) {
  if (c.deadlines.length) ensureCategory();
  const want = new Set();
  for (const d of c.deadlines) {
    const id = eventId(c, d);
    want.add(id);
    const ex = events.get(id);
    const ev = deadlineEvent(c, d, ex);
    if (!ex || OWNED.some(k => ex[k] !== ev[k])) store.saveEvent(ev, onError);
  }
  for (const ev of events.values()) {
    if (ev.companyId === c.id && !want.has(ev.id)) store.deleteEvent(ev.id, onError);
  }
}

function removeCompanyEvents(companyId) {
  for (const ev of events.values()) if (ev.companyId === companyId) store.deleteEvent(ev.id, onError);
}

function saveCompanyDoc(c) {
  const { id, ...data } = c;
  store.put(COL, id, { ...data, updatedAt: Date.now() }, onError);
  syncCompany(c);
}

// ---------- 以前のデータの取り込み ----------

function legacyToCompanies(data) {
  return (data.companies || []).map((c, i) => normalizeCompany({
    ...c,
    id: `c${c.id ?? i}`,
    createdAt: Date.now() + i,
    deadlines: (c.deadlines || []).map(d => ({ ...d, id: newId() })),
  }));
}

function importCompanies(list) {
  const have = new Set(companies.map(c => c.id));
  let n = 0;
  for (const c of list) {
    if (have.has(c.id)) continue;
    saveCompanyDoc(c);
    n++;
  }
  return n;
}

function offerLegacyImport() {
  let raw = null;
  try { if (!localStorage.getItem(MIGRATED_KEY)) raw = localStorage.getItem(LEGACY_KEY); } catch { /* なし */ }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  const list = legacyToCompanies(data);
  if (!list.length) return;
  if (confirm(`このブラウザに、以前の就活管理アプリのデータ（${list.length}社）があります。\n取り込んで、締め切りをスケジュールにも追加しますか？`)) {
    const n = importCompanies(list);
    toast(`${n}社を取り込みました`);
  }
  try { localStorage.setItem(MIGRATED_KEY, String(Date.now())); } catch { /* なし */ }
}

async function importFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('ファイルを読めませんでした'); return; }
  const list = data && data.app === 'shukatsu' ? (data.companies || []).map(normalizeCompany) : legacyToCompanies(data || {});
  if (!list.length) { toast('就活管理のデータが見つかりませんでした'); return; }
  if (!confirm(`${list.length}社のデータを読み込みます（すでにある企業はそのままです）。よろしいですか？`)) return;
  toast(`${importCompanies(list)}社を読み込みました`);
}

window.exportData = () => {
  const blob = new Blob([JSON.stringify({ app: 'shukatsu', exportedAt: new Date().toISOString(), companies }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shukatsu-backup-${C.todayKey().replaceAll('-', '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

window.logout = async () => { if (confirm('ログアウトしますか？')) { await store.signOut(); location.reload(); } };

// ---------- 表示（以前の版とほぼ同じ） ----------

function setSave(t) { $('save-ind').textContent = t; }
function fmtDate(s) { const { m, d } = C.parseDate(s); return `${m}/${d}`; }
function getDiff(dateStr) { return C.diffDays(dateStr, C.todayKey()); }
function dlText(d) { return `${fmtDate(d.date)}${d.time ? ` ${d.time}` : ''}`; }

function getUrgencyClass(diff) {
  if (diff === 0) return 'today';
  if (diff === 1) return 'one';
  if (diff >= 0 && diff <= 3) return 'three';
  if (diff >= 0 && diff <= 7) return 'week';
  return null;
}

function getDls(y, m, d) {
  const ds = `${y}-${C.pad(m + 1)}-${C.pad(d)}`;
  return companies.flatMap(c => c.deadlines.map(dl => ({ ...dl, companyId: c.id, company: c.name })).filter(dl => dl.date === ds));
}

function renderStats() {
  const counts = {};
  companies.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
  const upcoming = companies.flatMap(c => c.deadlines).filter(d => { const diff = getDiff(d.date); return diff >= 0 && diff <= 7; }).length;
  $('stats').innerHTML = `
    <div class="stat"><div class="stat-n">${companies.length}</div><div class="stat-l">企業数</div></div>
    <div class="stat"><div class="stat-n">${counts.interview || 0}</div><div class="stat-l">面接中</div></div>
    <div class="stat"><div class="stat-n">${counts.offer || 0}</div><div class="stat-l">内定</div></div>
    <div class="stat"><div class="stat-n" style="color:${upcoming > 0 ? 'var(--red)' : 'var(--text)'}">${upcoming}</div><div class="stat-l">7日以内の締切</div></div>`;
}

function renderUrgency() {
  const items = [];
  companies.forEach(c => c.deadlines.forEach(dl => {
    const diff = getDiff(dl.date);
    const cls = getUrgencyClass(diff);
    if (cls) items.push({ diff, cls, company: c.name, label: dl.label, time: dl.time });
  }));
  if (!items.length) { $('urgency-section').innerHTML = ''; return; }
  items.sort((a, b) => a.diff - b.diff || (a.time || '').localeCompare(b.time || ''));
  const rows = items.map(i => {
    const label = i.diff === 0 ? '今日が期限！' : i.diff === 1 ? '明日が期限' : `あと${i.diff}日`;
    return `<div class="urgency-item ${i.cls}">
      <span class="urgency-dot"></span>
      <span class="urgency-days">${label}</span>
      <span class="urgency-company">${esc(i.company)}</span>
      <span class="urgency-label">${esc(i.label)}${i.time ? ` ${i.time}` : ''}</span>
    </div>`;
  }).join('');
  $('urgency-section').innerHTML = `<div class="urgency-bar">
    <div class="urgency-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      直近の締め切り
    </div>
    <div class="urgency-cards">${rows}</div>
  </div>`;
}

function renderCal() {
  $('cal-month').textContent = `${curYear}年 ${MONTHS[curMonth]}`;
  const firstKey = `${curYear}-${C.pad(curMonth + 1)}-01`;
  const first = C.weekday(firstKey);
  const days = C.daysInMonth(curYear, curMonth + 1);
  const pd = curMonth === 0 ? 31 : C.daysInMonth(curYear, curMonth);
  const today = C.parseDate(C.todayKey());
  let html = DOWS.map(d => `<div class="cal-dow">${d}</div>`).join('');
  const cells = [];
  for (let i = 0; i < first; i++) cells.push({ day: pd - first + 1 + i, cur: false });
  for (let d = 1; d <= days; d++) cells.push({ day: d, cur: true });
  const rem = (7 - cells.length % 7) % 7;
  for (let i = 1; i <= rem; i++) cells.push({ day: i, cur: false });
  cells.forEach(c => {
    const dls = c.cur ? getDls(curYear, curMonth, c.day) : [];
    const isToday = c.cur && c.day === today.d && curYear === today.y && curMonth === today.m - 1;
    const isSel = c.cur && selectedDay === c.day;
    let urgCls = '';
    if (c.cur && dls.length) {
      const cls = getUrgencyClass(getDiff(dls[0].date));
      if (cls && !isToday) urgCls = ` urgent-${cls}`;
    }
    const dots = dls.slice(0, 5).map(d => `<span class="dot ${d.type}"></span>`).join('');
    html += `<div class="cal-day${c.cur ? '' : ' other-month'}${isToday ? ' today' : ''}${isSel ? ' selected' : ''}${urgCls}" ${c.cur ? `onclick="selectDay(${c.day})"` : ''}><div class="dn">${c.day}</div><div class="dot-wrap">${dots}</div></div>`;
  });
  $('cal-grid').innerHTML = html;
}

window.selectDay = d => { selectedDay = d === selectedDay ? null : d; renderCal(); renderDayDetail(); };

function renderDayDetail() {
  const el = $('day-detail');
  if (!selectedDay) { el.innerHTML = ''; return; }
  const dls = getDls(curYear, curMonth, selectedDay);
  if (!dls.length) { el.innerHTML = '<div class="detail-box"><div class="empty">この日の締め切りはありません</div></div>'; return; }
  el.innerHTML = `<div class="detail-box"><h4>${curMonth + 1}月${selectedDay}日 の締め切り</h4>${dls.map(d => `<div class="dl-row-display"><span class="dl-badge dl-${d.type}">${DL_LABELS[d.type]}</span><span style="font-size:13px;font-weight:500;flex:1">${esc(d.company)}</span><span style="font-size:12px;color:var(--text2)">${esc(d.label)}${d.time ? ` ${d.time}` : ''}</span><button class="btn-del-dl" onclick="deleteDeadline('${esc(d.companyId)}','${esc(d.id)}')" aria-label="削除">×</button></div>`).join('')}</div>`;
}

function renderCompanies() {
  const el = $('company-list');
  if (!companies.length) { el.innerHTML = '<div class="empty">企業を追加してください</div>'; return; }
  el.innerHTML = companies.map(c => `<div class="company-card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <span class="company-name">${esc(c.name)}</span>
      <span class="status-badge st-${c.status}">${STATUS_LABELS[c.status]}</span>
    </div>
    ${c.url ? `<a class="company-url" href="${esc(c.url)}" target="_blank" rel="noopener" style="display:block;text-decoration:none">🔗 マイページを開く</a>` : ''}
    <div class="deadlines">${c.deadlines.map(d => {
      const cls = getUrgencyClass(getDiff(d.date));
      const extra = cls ? ` style="outline:1.5px solid ${cls === 'today' ? 'var(--red)' : cls === 'one' ? 'var(--amber)' : cls === 'three' ? 'var(--purple)' : 'var(--text3)'};outline-offset:1px"` : '';
      return `<span class="dl-badge dl-${d.type}"${extra}>${esc(d.label)} ${dlText(d)}<span class="dl-del" onclick="deleteDeadline('${esc(c.id)}','${esc(d.id)}')">×</span></span>`;
    }).join('')}</div>
    ${c.memo ? `<div style="font-size:12px;color:var(--text2);margin-top:6px;padding-top:6px;border-top:0.5px solid var(--border);white-space:pre-wrap">${esc(c.memo)}</div>` : ''}
    <div class="card-actions">
      <button class="btn-edit" onclick="openEdit('${esc(c.id)}')">✎ 編集</button>
      <button class="btn-del" onclick="deleteCompany('${esc(c.id)}')">削除</button>
    </div>
  </div>`).join('') + '<button class="btn-add-small" onclick="openAdd()">＋ 企業を追加</button>';
}

window.changeMonth = d => {
  curMonth += d;
  if (curMonth > 11) { curMonth = 0; curYear++; }
  if (curMonth < 0) { curMonth = 11; curYear--; }
  selectedDay = null; renderCal(); renderDayDetail();
};

// ---------- 追加・編集 ----------

function dlInputRow(n, d) {
  const type = d ? d.type : 'es';
  return `<div class="dl-input-row" id="dlr-${n}" data-dlid="${esc(d ? d.id : '')}">
    <select id="dl-type-${n}"><option value="es"${type === 'es' ? ' selected' : ''}>ES締切</option><option value="int"${type === 'int' ? ' selected' : ''}>面接</option><option value="other"${type === 'other' ? ' selected' : ''}>その他</option></select>
    <input type="date" id="dl-date-${n}" value="${esc(d ? d.date : '')}">
    <input type="time" id="dl-time-${n}" value="${esc(d ? d.time : '')}" title="時刻（なくてもOK）">
    <input type="text" id="dl-label-${n}" value="${esc(d ? d.label : '')}" placeholder="ラベル">
    <button class="btn-remove" onclick="document.getElementById('dlr-${n}').remove()" aria-label="削除">×</button>
  </div>`;
}
window.addDlRow = () => { dlCount++; $('dl-rows').insertAdjacentHTML('beforeend', dlInputRow(dlCount, null)); };
window.openAdd = () => { editingId = null; showModal(null); };
window.openEdit = id => { editingId = id; showModal(companies.find(c => c.id === id)); };

function showModal(c) {
  dlCount = 0;
  const dlHtml = (c ? c.deadlines : []).map(d => { dlCount++; return dlInputRow(dlCount, d); }).join('');
  $('modal').innerHTML = `
    <h3>${c ? '企業を編集' : '企業を追加'}</h3>
    <div class="form-group"><label>企業名</label><input type="text" id="f-name" value="${c ? esc(c.name) : ''}" placeholder="例：株式会社〇〇"></div>
    <div class="form-group"><label>マイページURL</label><input type="url" id="f-url" value="${c ? esc(c.url) : ''}" placeholder="https://"></div>
    <div class="form-group"><label>ステータス</label><select id="f-status">${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}"${c && c.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="form-group"><label>締め切り（時刻は面接などで必要なときだけ）</label><div id="dl-rows">${dlHtml}</div><button type="button" onclick="addDlRow()" style="font-size:12px;background:none;border:0.5px dashed var(--border2);border-radius:var(--radius);padding:6px 10px;cursor:pointer;color:var(--text2);width:100%;margin-top:4px">＋ 締め切りを追加</button>
      <div class="sync-note">📅 締め切りはスケジュールにも自動で追加されます</div></div>
    <div class="form-group"><label>メモ・備考</label><textarea id="f-memo" placeholder="面接の感触、準備メモなど">${c ? esc(c.memo) : ''}</textarea></div>
    <div class="modal-footer">
      <button class="btn-cancel-modal" onclick="closeModal()">キャンセル</button>
      <button class="btn-save" onclick="saveCompany()">保存する</button>
    </div>`;
  $('modal-bg').classList.add('open');
  if (window.matchMedia('(min-width: 700px)').matches) $('f-name').focus();
}
window.closeModal = () => $('modal-bg').classList.remove('open');
window.handleModalBgClick = e => { if (e.target === $('modal-bg')) window.closeModal(); };

window.saveCompany = () => {
  const name = $('f-name').value.trim();
  if (!name) { alert('企業名を入力してください'); return; }
  const deadlines = [];
  document.querySelectorAll('[id^="dlr-"]').forEach(row => {
    const n = row.id.replace('dlr-', '');
    const type = $(`dl-type-${n}`).value;
    const date = $(`dl-date-${n}`).value;
    const time = $(`dl-time-${n}`).value;
    const label = $(`dl-label-${n}`).value.trim() || DL_LABELS[type];
    if (date) deadlines.push({ id: row.dataset.dlid || newId(), type, date, time, label });
  });
  const prev = editingId ? companies.find(x => x.id === editingId) : null;
  const c = normalizeCompany({
    ...(prev || {}),
    id: editingId || newId(),
    name, url: $('f-url').value.trim(), status: $('f-status').value, memo: $('f-memo').value.trim(), deadlines,
    createdAt: prev ? prev.createdAt : Date.now(),
  });
  saveCompanyDoc(c);
  window.closeModal();
  toast('保存しました（スケジュールにも反映）');
};

window.deleteCompany = id => {
  const c = companies.find(x => x.id === id);
  if (!c || !confirm(`「${c.name}」を削除しますか？\n（スケジュールに追加された締め切りも削除されます）`)) return;
  store.remove(COL, id, onError);
  removeCompanyEvents(id);
};

window.deleteDeadline = (companyId, dlId) => {
  const c = companies.find(x => x.id === companyId);
  if (!c || !confirm('この締め切りを削除しますか？\n（スケジュールからも削除されます）')) return;
  saveCompanyDoc({ ...c, deadlines: c.deadlines.filter(d => d.id !== dlId) });
};

function render() { renderStats(); renderUrgency(); renderCal(); renderDayDetail(); renderCompanies(); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

init();
