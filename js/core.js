// core.js — 日付・繰り返し・通知タイミングの計算。
// ブラウザ（アプリ）と GitHub Actions（通知送信）の両方から読み込むので、
// ブラウザ専用・Node専用の機能は使わないこと。

// 時刻はすべて日本時間（JST, UTC+9・サマータイムなし）として扱う
export const TZ_OFFSET_MIN = 9 * 60;
const DAY = 86400000;
const MAX_SCAN = 20000;

// 予定データの形式のバージョン。形式を変えるときは +1 して migrateEvent に変換処理を足す
export const EVENT_VERSION = 1;

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function pad(n) { return String(n).padStart(2, '0'); }

export function parseDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}
function dayNum(key) {
  const { y, m, d } = parseDate(key);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}
function keyFromDayNum(n) {
  const t = new Date(n * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function addDays(key, n) { return keyFromDayNum(dayNum(key) + n); }
export function diffDays(a, b) { return dayNum(a) - dayNum(b); } // a - b（日数）
export function weekday(key) { return (((dayNum(key) + 4) % 7) + 7) % 7; } // 0=日
export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

// "YYYY-MM-DD" + "HH:MM"（JST）→ エポックミリ秒
export function toMs(dateKey, time = '00:00') {
  const { y, m, d } = parseDate(dateKey);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - TZ_OFFSET_MIN * 60000;
}
// エポックミリ秒 → JST の日付・時刻
export function fromMs(ms) {
  const t = new Date(ms + TZ_OFFSET_MIN * 60000);
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
  };
}
export function todayKey(now = Date.now()) { return fromMs(now).date; }

// ---------- データ形式の変換（アップデートしても過去の予定を使い続けるため） ----------

export function migrateEvent(raw) {
  const e = { ...raw };
  const v = Number(e.v) || 0;
  if (v < 1) {
    // v0 → v1: 初版。足りない項目は normalizeEvent で補う
  }
  // 例) if (v < 2) { e.location = e.location ?? ''; }
  return normalizeEvent(e);
}

function normalizeRecurrence(r) {
  if (!r || !r.freq || r.freq === 'none') return null;
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(r.freq)) return null;
  return {
    ...r,
    freq: r.freq,
    interval: Math.max(1, parseInt(r.interval, 10) || 1),
    byDay: Array.isArray(r.byDay) ? [...new Set(r.byDay.map(Number))].filter(d => d >= 0 && d <= 6).sort() : [],
    until: r.until || null,
  };
}

function normalizeReminders(list) {
  if (!Array.isArray(list)) return [];
  const mins = list.map(r => Number(r && r.min)).filter(Number.isFinite);
  return [...new Set(mins)].sort((a, b) => b - a).map(min => ({ min }));
}

export function normalizeEvent(e) {
  // 知らない項目もそのまま残す（新しい版のアプリが保存したデータを古い版が消さないように）
  const out = {
    ...e,
    v: Math.max(Number(e.v) || 0, EVENT_VERSION),
    title: String(e.title ?? ''),
    note: String(e.note ?? ''),
    categoryId: e.categoryId ?? null,
    allDay: !!e.allDay,
    startDate: e.startDate,
    startTime: e.startTime || '00:00',
    endDate: e.endDate || e.startDate,
    endTime: e.endTime || e.startTime || '00:00',
    recurrence: normalizeRecurrence(e.recurrence),
    exdates: Array.isArray(e.exdates) ? [...new Set(e.exdates)].sort() : [],
    reminders: normalizeReminders(e.reminders),
  };
  if (out.endDate < out.startDate) out.endDate = out.startDate;
  if (!out.allDay && out.endDate === out.startDate && out.endTime < out.startTime) out.endTime = out.startTime;
  return out;
}

export function isRecurring(ev) { return !!(ev.recurrence && ev.recurrence.freq); }

// ---------- 繰り返しの展開 ----------

// fromKey 以降の開始日を昇順に返す
export function* startDates(ev, fromKey) {
  const ex = new Set(ev.exdates || []);
  const r = ev.recurrence;
  const s = ev.startDate;
  if (!r) {
    if (s >= fromKey && !ex.has(s)) yield s;
    return;
  }
  const iv = r.interval || 1;
  const until = r.until || null;
  const ok = k => k >= fromKey && k >= s && !ex.has(k);
  let guard = 0;

  if (r.freq === 'daily') {
    const k0 = Math.max(0, Math.floor(diffDays(fromKey, s) / iv));
    for (let k = k0; guard++ < MAX_SCAN; k++) {
      const key = addDays(s, k * iv);
      if (until && key > until) return;
      if (ok(key)) yield key;
    }
  } else if (r.freq === 'weekly') {
    const days = (r.byDay && r.byDay.length ? [...r.byDay] : [weekday(s)]).sort((a, b) => a - b);
    const ws = addDays(s, -weekday(s));
    const w0 = Math.max(0, Math.floor(diffDays(fromKey, ws) / (7 * iv)));
    for (let w = w0; guard++ < MAX_SCAN; w++) {
      const base = addDays(ws, w * 7 * iv);
      for (const d of days) {
        const key = addDays(base, d);
        if (until && key > until) return;
        if (ok(key)) yield key;
      }
    }
  } else {
    // monthly / yearly（存在しない日付 ― 31日や2/29 ― の月はとばす）
    const { y, m, d } = parseDate(s);
    const step = r.freq === 'monthly' ? iv : 12 * iv;
    const f = parseDate(fromKey);
    const k0 = Math.max(0, Math.floor(((f.y - y) * 12 + (f.m - m)) / step) - 1);
    for (let k = k0; guard++ < MAX_SCAN; k++) {
      const mi = (m - 1) + k * step;
      const yy = y + Math.floor(mi / 12);
      const mm = (mi % 12) + 1;
      if (d > daysInMonth(yy, mm)) {
        if (until && `${yy}-${pad(mm)}-01` > until) return;
        continue;
      }
      const key = `${yy}-${pad(mm)}-${pad(d)}`;
      if (until && key > until) return;
      if (ok(key)) yield key;
    }
  }
}

function timedDurationMs(ev) {
  return Math.max(0, toMs(ev.endDate, ev.endTime) - toMs(ev.startDate, ev.startTime));
}

// 開始日 key の回の具体的な日時
export function makeOcc(ev, key) {
  if (ev.allDay) {
    const endDate = addDays(key, diffDays(ev.endDate, ev.startDate));
    return { ev, key, allDay: true, startDate: key, endDate, startMs: toMs(key), endMs: toMs(addDays(endDate, 1)) };
  }
  const startMs = toMs(key, ev.startTime);
  const endMs = startMs + timedDurationMs(ev);
  const e = fromMs(endMs);
  return { ev, key, allDay: false, startDate: key, startTime: ev.startTime, endDate: e.date, endTime: e.time, startMs, endMs };
}

// カレンダー上で表示する最後の日（0:00ちょうどに終わる予定は前日まで）
export function lastDisplayDay(occ) {
  if (occ.allDay) return occ.endDate;
  if (occ.endMs <= occ.startMs) return occ.startDate;
  return fromMs(occ.endMs - 1).date;
}

function spanDays(ev) {
  if (ev.allDay) return diffDays(ev.endDate, ev.startDate);
  return Math.ceil(timedDurationMs(ev) / DAY) + 1;
}

// fromKey〜toKey（両端含む）に表示される回をすべて返す
export function occurrencesInRange(ev, fromKey, toKey) {
  const res = [];
  for (const key of startDates(ev, addDays(fromKey, -spanDays(ev)))) {
    if (key > toKey) break;
    const occ = makeOcc(ev, key);
    if (lastDisplayDay(occ) >= fromKey) res.push(occ);
  }
  return res;
}

// ---------- 通知 ----------
// reminders: [{ min }] … 開始時刻の min 分前に通知（終日予定は当日0:00が基準。負の値は基準より後）

function reminderMins(ev) {
  return (ev.reminders || []).map(r => r.min).filter(Number.isFinite);
}

// afterMs より後で最初に送る通知
export function nextFire(ev, afterMs) {
  const mins = reminderMins(ev);
  if (!mins.length) return null;
  const maxLead = Math.max(...mins), minLead = Math.min(...mins);
  const fromKey = addDays(fromMs(afterMs + minLead * 60000).date, -1);
  let best = null, n = 0;
  for (const key of startDates(ev, fromKey)) {
    const occ = makeOcc(ev, key);
    if (best && occ.startMs - maxLead * 60000 > best.at) break;
    for (const min of mins) {
      const at = occ.startMs - min * 60000;
      if (at > afterMs && (!best || at < best.at)) best = { at, key, min };
    }
    if (++n > MAX_SCAN) break;
  }
  return best;
}

// fromMs より後、toMs 以前に送るべき通知の一覧
export function firesBetween(ev, fromMsVal, toMsVal) {
  const mins = reminderMins(ev);
  if (!mins.length) return [];
  const maxLead = Math.max(...mins), minLead = Math.min(...mins);
  const fromKey = addDays(fromMs(fromMsVal + minLead * 60000).date, -1);
  const res = [];
  let n = 0;
  for (const key of startDates(ev, fromKey)) {
    const occ = makeOcc(ev, key);
    if (occ.startMs - maxLead * 60000 > toMsVal) break;
    for (const min of mins) {
      const at = occ.startMs - min * 60000;
      if (at > fromMsVal && at <= toMsVal) res.push({ at, key, min, occ });
    }
    if (++n > MAX_SCAN) break;
  }
  return res.sort((a, b) => a.at - b.at);
}

// 終日予定の「N日前のHH:MM」⇔ min の変換
export function allDayReminderToMin(daysBefore, time) {
  const [h, m] = time.split(':').map(Number);
  return daysBefore * 1440 - (h * 60 + m);
}
export function minToAllDayReminder(min) {
  const days = Math.max(0, Math.ceil(min / 1440));
  const tod = days * 1440 - min;
  return { days, time: `${pad(Math.floor(tod / 60) % 24)}:${pad(tod % 60)}` };
}

export function reminderLabel(min, allDay) {
  if (allDay) {
    const { days, time } = minToAllDayReminder(min);
    const t = time.replace(/^0/, '');
    return `${days === 0 ? '当日' : days === 1 ? '前日' : `${days}日前`} ${t}`;
  }
  if (min === 0) return '予定の時刻';
  const a = Math.abs(min);
  let s;
  if (a % 10080 === 0) s = `${a / 10080}週間`;
  else if (a % 1440 === 0) s = `${a / 1440}日`;
  else if (a % 60 === 0) s = `${a / 60}時間`;
  else s = `${a}分`;
  return min > 0 ? `${s}前` : `${s}後`;
}

// ---------- 表示用の文字列 ----------

export function formatDateJa(key, withYear = false) {
  const { y, m, d } = parseDate(key);
  return `${withYear ? `${y}/` : ''}${m}/${d}(${WEEKDAYS[weekday(key)]})`;
}

export function formatOccRange(occ) {
  if (occ.allDay) {
    return occ.startDate === occ.endDate
      ? `${formatDateJa(occ.startDate)} 終日`
      : `${formatDateJa(occ.startDate)}〜${formatDateJa(occ.endDate)}`;
  }
  if (occ.startDate === occ.endDate) return `${formatDateJa(occ.startDate)} ${occ.startTime}〜${occ.endTime}`;
  return `${formatDateJa(occ.startDate)} ${occ.startTime}〜${formatDateJa(occ.endDate)} ${occ.endTime}`;
}

export function relativeLabel(occ, now) {
  if (occ.allDay) {
    const d = diffDays(occ.startDate, todayKey(now));
    if (d === 0) return '今日';
    if (d === 1) return '明日';
    return d > 1 ? `${d}日後` : '開催中';
  }
  const m = Math.round((occ.startMs - now) / 60000);
  if (m <= 0) return m > -5 ? 'まもなく開始' : '開始済み';
  if (m < 60) return `あと${m}分`;
  if (m < 1440) return `あと${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
  return `あと${Math.round(m / 1440)}日`;
}
