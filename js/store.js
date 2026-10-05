// store.js — データの保存先。
// Firebase（PC・スマホで同期）と、Firebase未設定時のローカルモード（この端末のみ）の2種類。
import { migrateEvent, nextFire } from './core.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 保存する直前に、次の通知時刻を計算しておく（GitHub Actions はこの値で送信対象を探す）
function prepareEvent(ev) {
  const now = Date.now();
  const { id, ...data } = migrateEvent(ev);
  const nf = nextFire(data, now);
  data.notifyCursor = now;
  data.nextNotifyAt = nf ? nf.at : null;
  data.updatedAt = now;
  if (!data.createdAt) data.createdAt = now;
  return { id: id || newId(), data };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

// ---------- Firebase ----------

export async function createFirebaseStore(config) {
  const [appMod, authMod, fs] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js'),
  ]);
  const app = appMod.initializeApp(config);
  const auth = authMod.getAuth(app);
  let db;
  try {
    db = fs.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn('オフライン保存を使えないため通常モードで動作します', e);
    db = fs.getFirestore(app);
  }

  let uid = null;
  let unsubs = [];
  const stop = () => { unsubs.forEach(u => u()); unsubs = []; };
  const userDoc = (...p) => fs.doc(db, 'users', uid, ...p);
  const userCol = (...p) => fs.collection(db, 'users', uid, ...p);
  // オフライン時は書き込み完了を待つと止まってしまうので、待たずにエラーだけ拾う
  const fire = (p, onError) => { p.catch(onError || (e => console.error(e))); };

  return {
    mode: 'firebase',
    onAuth(cb) {
      authMod.onAuthStateChanged(auth, u => {
        uid = u ? u.uid : null;
        if (!u) stop();
        cb(u ? { uid: u.uid, email: u.email } : null);
      });
    },
    signIn: (email, pw) => authMod.signInWithEmailAndPassword(auth, email, pw),
    signUp: (email, pw) => authMod.createUserWithEmailAndPassword(auth, email, pw),
    resetPassword: email => authMod.sendPasswordResetEmail(auth, email),
    signOut: () => { stop(); return authMod.signOut(auth); },

    subscribe(h) {
      stop();
      fire(fs.setDoc(userDoc(), { lastSeenAt: Date.now() }, { merge: true }));
      const opts = { includeMetadataChanges: false };
      unsubs.push(fs.onSnapshot(userCol('events'), opts,
        s => h.events(s.docs.map(d => ({ id: d.id, ...d.data() }))), h.error));
      unsubs.push(fs.onSnapshot(userCol('categories'), opts,
        s => h.categories(s.docs.map(d => ({ id: d.id, ...d.data() }))), h.error));
      unsubs.push(fs.onSnapshot(userDoc('meta', 'settings'), { includeMetadataChanges: true },
        s => h.settings(s.exists() ? s.data() : {}, s.metadata.fromCache), h.error));
    },

    saveEvent(ev, onError) {
      const { id, data } = prepareEvent(ev);
      fire(fs.setDoc(userDoc('events', id), data), onError);
      return id;
    },
    deleteEvent(id, onError) { fire(fs.deleteDoc(userDoc('events', id)), onError); },
    saveCategory(cat, onError) {
      const { id, ...data } = cat;
      const cid = id || newId();
      fire(fs.setDoc(userDoc('categories', cid), data), onError);
      return cid;
    },
    deleteCategory(id, onError) { fire(fs.deleteDoc(userDoc('categories', id)), onError); },
    saveSettings(partial, onError) { fire(fs.setDoc(userDoc('meta', 'settings'), partial, { merge: true }), onError); },
    async savePushSub(subJson) {
      const id = await sha256Hex(subJson.endpoint);
      await fs.setDoc(userDoc('pushSubs', id), {
        subscription: subJson, userAgent: navigator.userAgent, updatedAt: Date.now(),
      });
    },
  };
}

// ---------- ローカルモード（Firebase未設定時。この端末のブラウザにだけ保存） ----------

const LOCAL_KEY = 'my-schedule-local-v1';

export function createLocalStore() {
  let state;
  try { state = JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch { state = {}; }
  state.events ||= {}; state.categories ||= {}; state.settings ||= {};
  let h = null;
  const persist = () => {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch (e) { console.error(e); }
    emit();
  };
  const emit = () => {
    if (!h) return;
    h.events(Object.entries(state.events).map(([id, d]) => ({ id, ...d })));
    h.categories(Object.entries(state.categories).map(([id, d]) => ({ id, ...d })));
    h.settings({ ...state.settings }, false);
  };
  return {
    mode: 'local',
    onAuth(cb) { cb({ uid: 'local', email: 'ローカルモード' }); },
    signOut: async () => {},
    subscribe(handlers) { h = handlers; emit(); },
    saveEvent(ev) { const { id, data } = prepareEvent(ev); state.events[id] = data; persist(); return id; },
    deleteEvent(id) { delete state.events[id]; persist(); },
    saveCategory(cat) {
      const { id, ...data } = cat;
      const cid = id || newId();
      state.categories[cid] = data; persist();
      return cid;
    },
    deleteCategory(id) { delete state.categories[id]; persist(); },
    saveSettings(partial) { Object.assign(state.settings, partial); persist(); },
    async savePushSub() { throw new Error('ローカルモードでは通知を使えません'); },
  };
}
