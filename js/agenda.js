// agenda.js — iPhone のショートカット用に「今日・明日の予定」の文章を作る
// アプリ（予定を変えたとき）と GitHub Actions（日付が変わったとき）の両方から使う。
import * as C from './core.js';

function lines(events, dateKey) {
  const occs = [];
  for (const ev of events) {
    if (!ev || !ev.startDate) continue;
    for (const occ of C.occurrencesInRange(ev, dateKey, dateKey)) occs.push(occ);
  }
  // 終日の予定が先、そのあとは開始時刻の順
  occs.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.startMs - b.startMs || String(a.ev.title).localeCompare(String(b.ev.title));
  });
  return occs.map(occ => {
    const title = occ.ev.title || '(タイトルなし)';
    let when;
    if (occ.allDay) when = '終日';
    else if (occ.startDate !== dateKey) when = `〜${occ.endTime}`;               // 前日から続いている予定
    else if (C.lastDisplayDay(occ) !== dateKey) when = `${occ.startTime}〜`;     // 翌日まで続く予定
    else when = `${occ.startTime}〜${occ.endTime}`;
    return `・${when} ${title}`;
  });
}

function dayText(label, dateKey, list) {
  const { m, d } = C.parseDate(dateKey);
  const head = `${label}、${m}月${d}日（${C.WEEKDAYS[C.weekday(dateKey)]}）`;
  return list.length ? `${head}の予定は${list.length}件です。\n${list.join('\n')}` : `${head}の予定はありません。`;
}

// events: 予定（migrateEvent 済み）の配列
export function buildAgenda(events, now = Date.now()) {
  const today = C.todayKey(now);
  const tomorrow = C.addDays(today, 1);
  const t = lines(events, today), n = lines(events, tomorrow);
  return {
    date: today,
    todayText: dayText('今日', today, t),
    tomorrowText: dayText('明日', tomorrow, n),
    todayCount: t.length,
    tomorrowCount: n.length,
  };
}

// 内容が変わったときだけ保存するための比較用
export const agendaKey = a => `${a.date}\n${a.todayText}\n${a.tomorrowText}`;

export function newAgendaToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
