// notify.mjs — GitHub Actions で約5分ごとに実行し、時間になった予定の通知を送る
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import webpush from 'web-push';
import { migrateEvent, firesBetween, nextFire, formatOccRange, relativeLabel, todayKey } from '../js/core.js';
import { buildAgenda } from '../js/agenda.js';

const EARLY_MS = 150 * 1000;        // 実行間隔のずれを考えて、最大2.5分早めに送る
const STALE_MS = 6 * 3600 * 1000;   // 6時間以上遅れてしまった通知は送らない
const FIRST_RUN_LOOKBACK_MS = 15 * 60 * 1000;

for (const k of ['FIREBASE_SERVICE_ACCOUNT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
  if (!process.env[k]) { console.error(`GitHub の Secrets に ${k} が設定されていません`); process.exit(1); }
}

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const now = Date.now();
const horizon = now + EARLY_MS;
let sent = 0, failed = 0, checked = 0;

const users = await db.collection('users').listDocuments();
// ショートカット用「今日・明日の予定」を、日付が変わっていたら作り直す
async function refreshAgenda(userRef) {
  const settings = await userRef.collection('meta').doc('settings').get();
  const token = settings.exists ? settings.get('agendaToken') : null;
  if (!token) return;
  const ref = db.collection('agendas').doc(token);
  const cur = await ref.get();
  if (cur.exists && cur.get('date') === todayKey(now)) return;
  const evs = (await userRef.collection('events').get()).docs
    .map(d => ({ id: d.id, ...d.data() })).filter(e => e.startDate).map(migrateEvent);
  await ref.set({ ...buildAgenda(evs, now), uid: userRef.id, updatedAt: now });
  console.log('今日の予定（ショートカット用）を更新');
}

for (const userRef of users) {
  try { await refreshAgenda(userRef); } catch (e) { console.error('今日の予定の更新に失敗:', e.message); }

  const due = await userRef.collection('events').where('nextNotifyAt', '<=', horizon).get();
  if (due.empty) continue;

  const subDocs = (await userRef.collection('pushSubs').get()).docs;
  const dead = new Set();

  for (const doc of due.docs) {
    checked++;
    const ev = migrateEvent({ id: doc.id, ...doc.data() });
    const cursor = typeof ev.notifyCursor === 'number' ? ev.notifyCursor : now - FIRST_RUN_LOOKBACK_MS;
    const fires = firesBetween(ev, cursor, horizon).filter(f => f.at >= now - STALE_MS);

    for (const f of fires) {
      const payload = JSON.stringify({
        title: ev.title || '予定',
        body: `${formatOccRange(f.occ)}（${relativeLabel(f.occ, now)}）${ev.note ? `\n${ev.note.slice(0, 80)}` : ''}`,
        tag: `${ev.id}:${f.key}:${f.min}`,
        url: './',
      });
      for (const s of subDocs) {
        if (dead.has(s.id)) continue;
        try {
          await webpush.sendNotification(s.data().subscription, payload, { TTL: 6 * 3600, urgency: 'high' });
          sent++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) {
            dead.add(s.id); // アプリを消した・通知をオフにした端末
          } else {
            failed++;
            console.error(`送信失敗 (${e.statusCode || ''}):`, e.body || e.message);
          }
        }
      }
    }

    const next = nextFire(ev, horizon);
    try {
      // アプリ側で同時に編集されていたら上書きしない（次回の実行で処理される）
      await doc.ref.update({ notifyCursor: horizon, nextNotifyAt: next ? next.at : null }, { lastUpdateTime: doc.updateTime });
    } catch (e) {
      console.warn(`予定 ${doc.id} の更新をスキップ: ${e.message}`);
    }
  }

  for (const id of dead) await userRef.collection('pushSubs').doc(id).delete();
  if (dead.size) console.log(`無効になった端末を ${dead.size} 件削除`);
}

console.log(`確認した予定: ${checked} 件 / 送信: ${sent} 件 / 失敗: ${failed} 件`);
if (failed) process.exitCode = 1;
