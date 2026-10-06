// config.js — 自分の環境に合わせて書きかえる設定ファイル（手順は「セットアップ手順.md」）

// Firebase の設定。null のままだと「ローカルモード」（この端末だけに保存・同期なし）で動く。
// Firebaseコンソールの「プロジェクトの設定 → マイアプリ」に表示される firebaseConfig を貼りつける。
export const firebaseConfig = {
  apiKey: "AIzaSyARF46Xn124WnsOjRLHG7XIpa4O3vgjUFA",
  authDomain: "my-schedule-cb7ad.firebaseapp.com",
  projectId: "my-schedule-cb7ad",
  storageBucket: "my-schedule-cb7ad.firebasestorage.app",
  messagingSenderId: "289422525072",
  appId: "1:289422525072:web:3e04f1b7c557bcb4554e15",
};

// 通知用の公開鍵（tools/vapid-keygen.html で作った「公開鍵」）。空のままだと通知はオンにできない。
export const VAPID_PUBLIC_KEY = 'BOUqYBaUDdxrH1U2DONMGo2IJVLONm5-pvSDo0_fIGBfd6qEznv3oYj1k8kqxGKuKKQZrr2f7aNSfooRpjRiZiQ';
