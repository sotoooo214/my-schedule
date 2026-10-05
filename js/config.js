// config.js — 自分の環境に合わせて書きかえる設定ファイル（手順は「セットアップ手順.md」）

// Firebase の設定。null のままだと「ローカルモード」（この端末だけに保存・同期なし）で動く。
// Firebaseコンソールの「プロジェクトの設定 → マイアプリ」に表示される firebaseConfig を貼りつける。
export const firebaseConfig = null;
/* 例:
export const firebaseConfig = {
  apiKey: "AIza....",
  authDomain: "my-schedule-xxxx.firebaseapp.com",
  projectId: "my-schedule-xxxx",
  storageBucket: "my-schedule-xxxx.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
};
*/

// 通知用の公開鍵（tools/vapid-keygen.html で作った「公開鍵」）。空のままだと通知はオンにできない。
export const VAPID_PUBLIC_KEY = '';
