// Hero demo: each chip replays what SuperWeb does for that kind of task.
// The page is complete without this script (the compare demo is in the HTML).
const DEMOS = {
  compare: {
    ask: '比較三家店 Aurora X1 耳機的價格、庫存與運費',
    steps: [
      ['讀結構', '讀取 3 個商品頁，找到「售價」「庫存」「運費」欄位 <code>[§2] [§3] [§5]</code>'],
      ['計畫', '打開 A 購物、B 購物、C 購物的 Aurora X1 頁面，逐頁記錄後整理成表'],
      ['等你批准', '開啟 3 個網站 · <span class="pill">允許</span><span class="pill ghost">拒絕</span>', 'wait'],
      ['結果', 'B 購物 NT$8,490 最便宜，現貨、免運 · 已輸出可下載的 CSV'],
      ['驗證', '3 項要求全部完成，每個價格都重新讀過原頁面', 'ok'],
    ],
  },
  form: {
    ask: '用這份 CSV 名單，幫我在報名頁逐筆填表送出',
    steps: [
      ['讀結構', '找到表單欄位 <code>[3] 姓名</code> <code>[4] Email</code> <code>[5] 手機</code> 與「送出報名」按鈕'],
      ['計畫', '每一筆：在「姓名」「Email」「手機」輸入資料，點「送出報名」，回到表單繼續下一筆'],
      ['等你批准', '點擊「送出報名」（第 2 筆：陳美玲）· <span class="pill">允許</span><span class="pill ghost">拒絕</span>', 'wait'],
      ['結果', '3 筆全部送出，每筆都看到「報名成功」頁面'],
      ['驗證', '程式逐欄核對：CSV 裡的 9 個值都確實輸入過', 'ok'],
    ],
  },
  watch: {
    ask: '每天早上 9 點檢查 Aurora X1，低於 NT$8,300 就通知我',
    steps: [
      ['讀結構', '商品頁售價在 <code>[§2]</code>，庫存在 <code>[§3]</code>'],
      ['計畫', '建立排程：每天 09:00 打開商品頁，讀價格與庫存，和目標價比較'],
      ['等你批准', '建立每日排程（背景執行）· <span class="pill">允許</span><span class="pill ghost">拒絕</span>', 'wait'],
      ['結果', '今天 NT$8,490，尚未達標 · 已記錄為比對基準'],
      ['驗證', '系統比對（以此為準）：8,490 高於 8,300，價格有變動時才會通知', 'ok'],
    ],
  },
  research: {
    ask: '整理兩篇評測對 Aurora X1 續航力的說法，附來源',
    steps: [
      ['讀結構', '讀取 2 篇評測，共 14 個段落 <code>[§1]…[§14]</code>'],
      ['計畫', '只讀這兩個網址，摘出續航時間與測試條件'],
      ['等你批准', '前往第二篇評測 · <span class="pill">允許</span><span class="pill ghost">拒絕</span>', 'wait'],
      ['結果', '一般使用約 32 小時【§3】，開啟降噪約 26 小時【§4】'],
      ['驗證', '每個數字都附原文段落，點引用就跳回原頁面', 'ok'],
    ],
  },
};

const run = document.getElementById('run');
const ask = document.getElementById('ask-text');
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let timers = [];

function show(id) {
  const demo = DEMOS[id];
  if (!demo) return;
  timers.forEach(clearTimeout);
  timers = [];
  ask.textContent = demo.ask;
  run.replaceChildren(...demo.steps.map(([k, html, cls]) => {
    const li = document.createElement('li');
    li.dataset.k = k;
    li.innerHTML = `<span class="t">${html}</span>`;
    if (cls) li.className = cls;
    if (!reduce) li.classList.add('pending');
    return li;
  }));
  if (!reduce) [...run.children].forEach((li, i) => timers.push(setTimeout(() => li.classList.remove('pending'), 180 + i * 420)));
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    show(chip.dataset.demo);
  });
});
