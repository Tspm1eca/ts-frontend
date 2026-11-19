# ACU Visualizer UI — 手動更新按鍵 / index.js Hook 實作與除錯指南

> 適用檔案：`main.js`（本倉庫 `Tspm1eca/ts-frontend`）
> 文件對應版本：**main.js v22.9**（約 5163 行 / ~322 KB）
> 目的：當上游 `index.js`（AutoCardUpdater 擴展本體）更新後若本功能出錯，任何 LLM 可依本文件**快速定位壞在哪個「錨點」並修好**。

---

## 0. 30 秒快速除錯（TL;DR）

1. 打開瀏覽器 Console，在**頂層頁面**執行：
   ```js
   __acuManualDebug()
   ```
   正常結果應為：
   ```json
   { "foundApp": true, "hasRouter": true, "hasRootShell": true, "hasManualUpdateApi": true }
   ```
2. 若某個為 `false`，對照第 8 節的「診斷碼 → 病因 → 修法」。
3. 本功能的所有 index.js 依賴都集中在 **`main.js` 的「手動按鍵助手區塊」（約 main.js:2314–2812）**，其餘是 UI 綁定。**只要改那一段，不用改 index.js。**
4. 修完務必：
   - `node --check main.js`
   - 版本號 `ACU_UI_VERSION` +0.1
   - commit + push（見第 10 節）
   - 用第 9 節的「不觸發 LLM 測試」驗證。

> **鐵律（用戶明確要求）**：任何情況下都**不可以**「退回擴展全局的合併條數／最近層數」來填表。若無法正確設定 batch/depth，必須**中止填表**，否則會用錯樓層內容污染表格。

---

## 1. 架構總覽

```
SillyTavern 頁面 (http://127.0.0.1:8000)
 ├─ 擴展 index.js  →  window.AutoCardUpdaterAPI（公開 API）
 │                  →  window.AutoCardUpdaterV2API（面板開關橋）
 │                  →  在宿主 document body 掛 <div id="acu-app-v2">，內含 Vue3 + Pinia App
 │                       └─ FormFillPage（"手動填表"頁）內有 useManualUpdate() 組合式 API
 │
 └─ 酒館助手 JS-Slash-Runner 的 about:srcdoc iframe（frames[3]，即 top.3）
      └─ loader.js → fetch main.js（GitHub@commit sha / jsDelivr）→ (0,eval) 執行
           └─ main.js（本檔）把 UI 渲染進「最外層宿主 document」
                ├─ 公開 API 走 window.AutoCardUpdaterAPI（穩定）
                └─ batch/depth 走 Vue hook 進 #acu-app-v2 的內部 manualUpdate（脆弱，需本文件）
```

重點：
- **main.js 跑在 `about:srcdoc` iframe 裡**，但 UI 是掛到「最外層可存取文件」。所以 `window`（iframe）與「顯示 UI 的 document（top）」是不同 window。
- `manualUpdate()` 公開 API **只接受 `{confirm}`**，不吃 batch/depth/表格。
- 表格範圍有公開 API（穩定）；**batch/depth 沒有公開 setter**，只能靠 Vue 內部 hook。這就是本文件存在的原因。

---

## 2. index.js 內部的關鍵錨點（Hook 依賴）

> 以下「位置」是舊版量到的 byte offset，**每次 index.js 更新都會位移，請用搜尋字串（grep）而非位置**。

| 用途 | 搜尋字串（在 index.js 內 grep） | 說明 / 目前值 |
|---|---|---|
| Vue App 容器 id | `acu-app-v2` | `<div id="acu-app-v2" style="display:none">`，掛在宿主 document.body |
| App 掛載 | `__vue_app__` | Vue runtime 把 app 掛到容器 `el.__vue_app__`（pos ~3860758） |
| Pinia | `$pinia` / `globalProperties` | `app.config.globalProperties.$pinia`；亦可能只在 `app._context.provides` 內 |
| 外殼 store | `defineStore("acu-v2-root-shell"` | state `{isOpen,...}`，actions `setOpen(t)` |
| 路由 store | `defineStore("acu-v2-router"` | actions `setActivePage(id)`；state `activePageId` |
| 填表頁 id | `form-fill` | `jG="form-fill"`；預設頁 `dashboard` |
| 填表頁組件 | `__name:"FormFillPage"` | setup 回傳 `{ manualUpdate, ... }` |
| 組合式 API | `function useManualUpdate` | 內含 `manualBatchSize` / `manualContextDepth` refs 與 setter |
| 設定 setter | `setManualContextDepth` / `setManualBatchSize` | 寫 `cC.manualUpdateContextDepth` / `cC.manualUpdateBatchSize` 後 `saveSettings_ACU()` |
| 內部設定物件 | `manualUpdateBatchSize` / `manualUpdateContextDepth` | 模組內 `cC`，**未公開** |
| 解析函式 | `resolveManualUpdateContextDepth_ACU` / `resolveManualUpdateBatchSize_ACU` | depth 未設時 fallback `autoUpdateThreshold`；batch 未設時 fallback `3` |
| 執行引擎 | `orchestrateManualUpdate_ACU` | 開頭 `v=resolveDepth(), k=resolveBatch()`；`slice(v>0?-v:0)`（v=0 表示全部層） |
| 宿主解析 | `resolveAcuHost` | 由 window 向上取最外層可存取 document |
| 面板開關橋 | `installAutoCardUpdaterV2ApiOnTarget_ACU` / `AutoCardUpdaterV2API` | `{open, openVisualizer, refreshVisualizer}` |
| 根 VNode | `app._container._vnode` | **關鍵**：某些打包版 `app._instance` 為 null，根 VNode 只在 `_container._vnode` |

### 2.1 已知的 `useManualUpdate()` 回傳（節選）
```js
{
  selectedManualTableKeys, manualContextDepth, manualBatchSize, manualExtraHint,
  manualUpdateBusy, catchUpBusy, sheetKeys, sheetNames, runtimeReady,
  selectedSheetSummary, refresh,
  setManualContextDepth(t) { /* normalizeNonNegativeInteger; cC.manualUpdateContextDepth = n; saveSettings_ACU() */ },
  setManualBatchSize(t)     { /* normalizePositiveInteger;   cC.manualUpdateBatchSize = n;  saveSettings_ACU() */ },
  setManualSelectedKeys, selectAllManualTables, selectNoManualTables,
  runManualUpdate, runManualCatchUp
}
```
> 注意：它們是**元件 setup 內的閉包**，只能透過 VNode 樹取得，沒有掛在 window。

---

## 3. main.js 的實作（手動更新按鍵系統）

### 3.1 資料模型 & 儲存
- localStorage key：`STORAGE_KEY_MANUAL_BUTTONS = 'acu_manual_buttons_v1'`（main.js:25）
- 每個按鈕：
  ```json
  {
    "id": "default 或 mb_xxxxxxx",
    "label": "狀態填表",
    "icon": "fa-bolt",
    "batchSize": 3,          // 每 N 條 AI 回覆合併為一次填表（>=1）
    "contextDepth": 3,       // 手動處理最近 N 層（>=0，0=全部）
    "useAllTables": false,
    "tableKeys": ["sheet_quan_ju_shu_ju_biao", "..."],
    "tableNames": ["全局数据表", "..."]   // 用於確認氣泡顯示，缺表時的後備名稱
  }
  ```
- 預設（尚未設定時）：單一 `{id:'default', label:'手动更新', icon:'fa-bolt', batchSize:3, contextDepth:3, useAllTables:true, tableKeys:[]}`。

### 3.2 關鍵函式（依 main.js v22.9 行號，未來會位移，用名稱找）
| 函式 | 行號 | 作用 |
|---|---|---|
| `uiHint(msg,type)` | 2314 | 顯示提示；**由最外層宿主 window 找 toastr**，找不到在宿主文件插 4.5 秒橫幅。修過：iframe 內 toastr 看不見的 bug |
| `normalizeManualButton(b)` | 2338 | 清洗/校驗按鈕配置（icon 必 `/^fa-/`，batch>=1，depth>=0） |
| `getManualButtons()` / `saveManualButtons(arr)` | 2354 / 2366 | 讀寫 localStorage（無 key 回預設） |
| `getManualButtonById(id)` | 2373 | 取單一按鈕 |
| `getAvailableTableOptions()` | 2375 | 合併 `exportTableAsJson()` + `getTableTemplate({scope:'chat'})` + `getTableTemplate({scope:'global'})` + `getTableData(false)`，只收 `/^sheet_/i` 且有 `name` 的 `{key,name}` |
| `findManualUpdateApiInVNode(vnode)` | 2404 | 遞迴 VNode 找 `component.setupState.manualUpdate`（或 setupState/exposed 直函式） |
| `resolveAcuHostWindows()` | 2445 | 收集自身+parent 鏈+所有 frames（最多 24），最外層在最後 |
| `findAcuV2App()` | 2479 | 最外層優先找 `#acu-app-v2.__vue_app__`，否則掃所有帶 `__vue_app__` 的元素；取 pinia（`$pinia` 或 `provides`），回 `{el,app,pinia}` |
| `getAppRootVNode(app)` | 2532 | `app._instance.subTree` → 否則 `app._container._vnode` → 否則 null |
| `applyManualFillConfig({batchSize,contextDepth})` | 2541 | **核心 hook**（見 3.3） |
| `__acuManualDebug()` | 2615-2647 | 診斷函式，掛到所有宿主 window |
| `showManualConfirm(btn, anchorEl)` | 2650 | 「再次確定」氣泡，貼在按鈕上方（absolute + 父容器座標） |
| `runManualButton(btnId, anchorEl)` | 2766 | 按鍵主流程（見 3.4） |
| `showManualButtonsManager()` | 2807 | 齒輪彈窗：新增/刪除/編輯按鈕、圖標選擇器、表格多選 |
| `renderInterface` 內 actionBtns | 3033-3068 | 動態生成 `acu-manual-btn-<id>` + 齒輪 `acu-btn-manual-config`；排序見 baseActionOrder |
| `bindEvents` 綁定 | 4205-4216 | `.acu-manual-btn` → `runManualButton($(this).data('manual-id'), this)`；`#acu-btn-manual-config` → 管理器 |

### 3.3 `applyManualFillConfig` 演算法（重點照抄）
```js
const applyManualFillConfig = async (cfg) => {
  try {
    let found = findAcuV2App();
    if (!found) {
      // 面板若未掛載，用公開橋觸發一次掛載（之後立刻隱藏）
      const wins = resolveAcuHostWindows();
      for (const w of wins) { const a = w.AutoCardUpdaterV2API; if (a && a.open) { a.open(); break; } }
      for (let i = 0; i < 20 && !found; i++) { await sleep(50); found = findAcuV2App(); }
    }
    if (!found) return { ok: false, code: 'no-app' };
    const { el, app, pinia } = found;
    if (!pinia || !pinia._s || !pinia._s.get) return { ok: false, code: 'no-pinia' };

    let rootShell = pinia._s.get('acu-v2-root-shell');
    const prevDisplay = el.style.display;
    const prevOpen = rootShell ? rootShell.isOpen : undefined;
    let router = pinia._s.get('acu-v2-router');
    let prevPage;
    try {
      el.style.display = 'none';                       // 防閃爍（openAcuV2App 才會設 display=''）
      if (rootShell && rootShell.setOpen && !rootShell.isOpen) rootShell.setOpen(true); // 必須先開外殼
      for (let i = 0; i < 24 && (!router || !router.setActivePage); i++) { await sleep(25); router = pinia._s.get('acu-v2-router'); }
      if (!router || !router.setActivePage) return { ok: false, code: 'no-router' };
      prevPage = router.activePageId;
      router.setActivePage('form-fill');               // 只有掛載 MainArea 才有 FormFillPage
      let api = null;
      for (let i = 0; i < 60 && !api; i++) { await sleep(25); api = findManualUpdateApiInVNode(getAppRootVNode(app)); }
      if (!api) return { ok: false, code: 'no-api' };

      let okDepth = (cfg.contextDepth == null);
      let okBatch = (cfg.batchSize == null);
      const miss = [];
      if (!okDepth) { if (typeof api.setManualContextDepth === 'function') { api.setManualContextDepth(Math.max(0, Math.floor(Number(cfg.contextDepth)||0))); okDepth = true; } else miss.push('setManualContextDepth'); }
      if (!okBatch) { if (typeof api.setManualBatchSize === 'function') { api.setManualBatchSize(Math.max(1, Math.floor(Number(cfg.batchSize)||1))); okBatch = true; } else miss.push('setManualBatchSize'); }
      // 兩個都必須成功，缺一即失敗
      if (!okDepth || !okBatch) return { ok: false, code: 'no-setter' + (miss.length ? ':' + miss.join('/') : '') };
      return { ok: true };
    } finally {
      try { if (router && router.setActivePage && prevPage != null) router.setActivePage(prevPage); } catch (e) {}
      try { if (rootShell && rootShell.setOpen && prevOpen === false) rootShell.setOpen(false); } catch (e) {}
      el.style.display = prevDisplay;
    }
  } catch (e) { return { ok: false, code: 'exc:' + (e && e.message ? e.message : String(e)) }; }
};
```

### 3.4 `runManualButton` 主流程（含「不降級」政策）
```js
const runManualButton = async (btnId, anchorEl) => {
  const api = getCore().getDB();
  if (!api || typeof api.manualUpdate !== 'function') { uiHint('无法调用数据库更新接口', 'error'); return; }
  const btn = getManualButtonById(btnId) || { label:'手动更新', batchSize:3, contextDepth:3, useAllTables:true, tableKeys:[] };

  // 1) 二次確認氣泡（貼在按鈕上方；取消就中止）
  const confirmed = await showManualConfirm(btn, anchorElResolved);
  if (!confirmed) return;

  // 2) 設定表格範圍（公開 API）
  try {
    if (btn.useAllTables) { if (api.clearManualSelectedTables) api.clearManualSelectedTables(); }
    else if (btn.tableKeys && btn.tableKeys.length && api.setManualSelectedTables) api.setManualSelectedTables(btn.tableKeys);
    else if (api.clearManualSelectedTables) api.clearManualSelectedTables();
  } catch (e) { console.warn('[ACU UI] 设置填表范围失败:', e); }

  // 3) 套用 batch/depth（Vue hook）
  const applyRes = await applyManualFillConfig({ batchSize: btn.batchSize, contextDepth: btn.contextDepth }).catch(() => null);
  if (!applyRes || !applyRes.ok) {
    // ★ 絕不降級！設定不到就中止，且提示要看得到
    try { console.info('[ACU UI] 手动填表 hook 连接诊断：', window.__acuManualDebug && window.__acuManualDebug()); } catch (e) {}
    uiHint('無法正確設定「每 N 條 AI 回覆合併為一次填表」/「手動處理最近 N 層」，已停止本次填表，以免用錯誤樓層內容寫入表格。（診斷碼：' + ((applyRes && applyRes.code) || 'unknown') + '）', 'error');
    return;
  }

  // 4) 真正執行填表
  try { await api.manualUpdate({ confirm: false }); }
  catch (e) { console.error('[ACU UI] 手动更新失败:', e); uiHint('手动更新失败', 'error'); }
};
```

### 3.5 表格選擇的注意事項
- `setManualSelectedTables(keys)` 內部會**用當前 runtime sheet keys 過濾**，不在當前聊天 sheet 清單裡的 key 會被丟掉；`hasManualSelection` 會設 true。
- `clearManualSelectedTables()` 代表「全部表格」。
- **真實選擇以 `api.getManualSelectedTables().selectedTables` 為準**；`FormFillPage.manualUpdate.selectedManualTableKeys` 是**掛載時快照**，不會隨外部 `setManualSelectedTables` 即時更新（除錯時別被它誤導）。

---

## 4. 診斷函式 `__acuManualDebug()`

掛在每個可存取宿主 window（main.js:2615-2647）。回傳：
```json
{
  "windowCount": 13,
  "windows": [ { "href": "...", "appEl": { "exists": true, "hasVueApp": true, "display": "none" }, "vueEls": 1 } ],
  "foundApp": true,
  "piniaStores": ["acu-v2-root-shell", "acu-v2-router", "..."],
  "hasRouter": true,
  "hasRootShell": true,
  "hasManualUpdateApi": true
}
```
判讀：
- `foundApp:false` → 找不到 `#acu-app-v2.__vue_app__`（app 容器 id/掛載方式變了）。
- `hasRouter:false` → store id `acu-v2-router` 改名或 lazy 未建立。
- `hasRootShell:false` → store id `acu-v2-root-shell` 改名。
- `hasManualUpdateApi:false` → 頁面 id 不是 `form-fill`、或 `FormFillPage` 改名、或 setter 改名、或根 VNode 路徑變了。

---

## 5. 公開 API 依賴清單（相對穩定）

```js
const api = getCore().getDB();   // = host window.AutoCardUpdaterAPI
api.manualUpdate({ confirm: false });     // 觸發手動填表（只吃 confirm）
api.setManualSelectedTables(keys);        // 設定要填的表格（sheetKey 陣列）
api.clearManualSelectedTables();          // 清空＝全部表格
api.getManualSelectedTables();            // {selectedTables:[...], hasManualSelection}
api.exportTableAsJson();                  // 當前表資料（key=sheetKey，value.name=表名）
api.getTableTemplate({ scope:'chat' });   // 表格模板（含 name，聊天未載入時也可列名）
api.getTableTemplate({ scope:'global' }); // 全域模板
```
> 若某天這些公開 API 改名，優先用 `Object.keys(window.AutoCardUpdaterAPI)` 找相近名稱（`manual`/`Table`/`TableTemplate`）。

---

## 6. 除錯決策樹（index.js 更新後）

```
A. 開 Console 跑 __acuManualDebug()
├─ 函式不存在 → main.js 沒載入/版本太舊 → 重新整理或 __ACU_UI_RELOAD__()
├─ foundApp:false
│   ├─ 檢查 index.js 是否還有 `id="acu-app-v2"`；改名 → 改 findAcuV2App 的 getElementById(...)
│   └─ 檢查容器是否改掛到 iframe 而非宿主 → 看 __acuManualDebug().windows 哪個有 appEl
├─ hasRootShell:false 或 hasRouter:false
│   ├─ grep index.js `defineStore("acu-v2-` 看新 id
│   └─ 改 applyManualFillConfig 內 pinia._s.get('...') 字串；或改成「能力探測」：
│        const stores=[...pinia._s.keys()]; // 找有 setOpen / setActivePage 的
├─ hasManualUpdateApi:false
│   ├─ 先確認 router.setActivePage('form-fill') 仍有效（頁面標題應變「填表工作台」）
│   │   └─ 若頁面 id 改了：grep index.js 頁面註冊表找新 id
│   ├─ 確認 getAppRootVNode：console 執行
│   │     const el=document.getElementById('acu-app-v2'),app=el.__vue_app__;
│   │     console.log(!!(app._instance&&app._instance.subTree), !!(app._container&&app._container._vnode));
│   ├─ 若都 false → Vue 版本改變，改找 `app._vnode` 或 `app._instance?.vnode`
│   └─ 若根 VNode 有了但仍找不到 → 遞迴 dump 組件 setupState keys，
│       看 setter 是否改名（原為 setManualBatchSize / setManualContextDepth）
└─ 全部 true 但仍失敗 → 看 applyManualFillConfig 回傳的 code（runManualButton 會打印）
```

### 6.1 通用「能力探測」Console 腳本（LLM 可直接貼）
```js
(() => {
  const el = document.getElementById('acu-app-v2');
  const app = el && el.__vue_app__;
  if (!app) return { err: 'no #acu-app-v2.__vue_app__' };
  const gp = (app.config && app.config.globalProperties) || {};
  const pinia = gp.$pinia || (() => {
    try { const k = Reflect.ownKeys(app._context.provides); for (const x of k) { const v = app._context.provides[x]; if (v && v._s && v._s.get) return v; } } catch (e) {}
    return null;
  })();
  const storeIds = pinia ? [...pinia._s.keys()] : [];
  const dump = (v, d = 0, acc = []) => {
    if (!v || d > 8 || acc.length > 200) return acc;
    if (v.component) {
      const s = v.component.setupState || {};
      const keys = Object.keys(s).filter(k => /manual|batch|depth|context|setManual/i.test(k));
      if (keys.length) acc.push({ depth: d, name: v.component.type && (v.component.type.__name || v.component.type.name), keys });
      dump(v.component.subTree, d + 1, acc);
    }
    const ch = v.children;
    if (Array.isArray(ch)) ch.forEach(c => dump(c, d + 1, acc));
    else if (ch && ch.default) dump(ch.default, d + 1, acc);
    if (v.suspense) dump(v.suspense.activeBranch, d + 1, acc);
    return acc;
  };
  const root = (app._instance && app._instance.subTree) || (app._container && app._container._vnode) || app._vnode;
  return { storeIds, hasInstanceSubTree: !!(app._instance && app._instance.subTree), hasContainerVNode: !!(app._container && app._container._vnode), manualCandidates: dump(root) };
})()
```
把 `manualCandidates` 印出來，就能看到 setter 的新名字與所在組件。

---

## 7. 常見「假錯誤」與陷阱（不是 bug）

| 現象 | 原因 | 處理 |
|---|---|---|
| 儀表板版本號比實際舊 | loader 熱重載只換執行碼、不重繪版本標籤 | F5 整頁刷新即可 |
| 按鈕一直轉/超時、poll 很久 | 背景分頁 `setTimeout` 被節流（25ms→1000ms） | 切到前景再測；或縮短 poll |
| 確認氣泡看不到 | 舊版把氣泡 append 到 `body` 且 `position:fixed`，受 `contain:layout`/跨文件影響跑到左上角 | v22.3 起改 absolute + 以按鈕父容器定位 |
| 錯誤提示看不到 | main.js 在 srcdoc iframe，toastr 建在 iframe 內看不見 | v22.9 起 `uiHint` 往最外層宿主 window 找 toastr，否則插橫幅 |
| 表名顯示 `未知表格（sheet_xxx）` | 當前聊天未載入、表格模板也取不到 | v22.5 起合併 exportTableAsJson + getTableTemplate(chat/global)；若仍缺可查 `getAvailableTableOptions()` |
| `manualUpdate.selectedManualTableKeys` 與實際不符 | 它是掛載快照 | 以 `api.getManualSelectedTables()` 為準 |
| 改了 main.js 但頁面沒變 | jsDelivr/raw 分支快取，或 loader 沒重貼 | 用 @commit sha 載入（loader 已做）；loader 改動需重新貼到酒館助手 |

---

## 8. 診斷碼對照表（`applyManualFillConfig` 回傳 code）

| code | 含義 | 可能病因 | 修法 |
|---|---|---|---|
| `no-app` | 找不到 `#acu-app-v2.__vue_app__` | 容器 id 改、改掛到別的 window、擴展未啟動 | 改 `findAcuV2App()` 的 id / 掃描邏輯；確認 `AutoCardUpdaterV2API.open` 可用 |
| `no-pinia` | 有 app 但取不到 pinia | Vue/Pinia 版本改、provide key 改 | 用能力探測找 `_s.get` 物件；放寬 `findAcuV2App` |
| `no-router` | 取不到 `acu-v2-router` 或無 `setActivePage` | store id 改名、外殼未開導致 lazy store 未建立 | 先 `setOpen(true)`；更新 store id 或能力探測 |
| `no-api` | VNode 裡找不到 `manualUpdate` | 頁面 id 改（非 `form-fill`）、FormFillPage 改名、根 VNode 路徑改、setter 改名 | 見第 6 節決策樹；優先確認 `getAppRootVNode` 與頁面 id |
| `no-setter:setManualContextDepth` | 有 api 但缺深度 setter | setter 改名 | 用 `manualCandidates` 找新名，改 `applyManualFillConfig` 與 `findManualUpdateApiInVNode` 判定條件 |
| `no-setter:setManualBatchSize` | 有 api 但缺批次 setter | setter 改名 | 同上 |
| `exc:<msg>` | setter 執行時拋錯 | 參數型別/內部邏輯改 | 看 msg；必要時先讀現值再寫 |

> **重要**：`findManualUpdateApiInVNode` 目前用「有沒有 `setManualBatchSize` 函式」來認物件。若 setter 改名，這裡會直接回 `no-api`（而不是 no-setter）。修的時候**兩處都要改**：辨識條件 + 呼叫名稱。

---

## 9. 不觸發 LLM 的驗證方法（強烈建議每次改完都做）

在**頂層頁面 Console**（不是 iframe）執行：

```js
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const api = window.AutoCardUpdaterAPI;
  const orig = api.manualUpdate;
  let calls = 0;
  api.manualUpdate = async () => { calls++; return false; };   // 樁：不發請求

  // 1) 找到按鈕並點擊（用 data-manual-id）
  const btn = document.querySelector('.acu-manual-btn');        // 或指定 data-manual-id
  btn.click();
  await sleep(400);
  const ok = document.getElementById('mconf-ok');               // 確認氣泡的「確定執行」
  if (ok) ok.click();
  await sleep(900);

  const called = calls;                                         // 正常應為 1
  // 2) 讀回 cC 內的 batch/depth（開一次 form-fill 再讀元件 ref）
  const el = document.getElementById('acu-app-v2');
  const app = el.__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const rs = pinia._s.get('acu-v2-root-shell');
  const rt = pinia._s.get('acu-v2-router');
  const prevOpen = rs.isOpen, prevDisplay = el.style.display;
  rs.setOpen(true); rt.setActivePage('form-fill');
  await sleep(300);
  const walk = (v, d = 0) => {
    if (!v || d > 60) return null;
    const c = v.component;
    if (c) {
      const s = c.setupState;
      if (s && s.manualUpdate && typeof s.manualUpdate.setManualBatchSize === 'function') return s.manualUpdate;
      const r = walk(c.subTree, d + 1); if (r) return r;
    }
    const ch = v.children;
    if (Array.isArray(ch)) { for (const x of ch) { const r = walk(x, d + 1); if (r) return r; } }
    return null;
  };
  const root = (app._instance && app._instance.subTree) || (app._container && app._container._vnode);
  const mu = walk(root);
  const cfg = mu ? { batch: mu.manualBatchSize.value, depth: mu.manualContextDepth.value } : null;
  rs.setOpen(prevOpen); el.style.display = prevDisplay;

  api.manualUpdate = orig;                                      // 還原
  return { called, cfg, selected: api.getManualSelectedTables().selectedTables };
})()
```
- `called === 1` 且 `cfg` 與按鈕設定一致 → 正常。
- 想測失敗路徑：把某個 setter 換成 `function(){ throw new Error('test') }`，再點按鈕，應得到 `called === 0` 且畫面出現「已停止本次填表」提示。

---

## 10. 部署 / 熱更新（重要）

- 倉庫：`Tspm1eca/ts-frontend`；只發布 `main.js`。
- 使用者把 **`loader.js` 貼到酒館助手（JS-Slash-Runner）**；loader 會：
  1. GitHub API 取最新 commit SHA（帶 ETag，304 不計次）；
  2. 依 SHA 從 `cdn.jsdelivr.net/gh/Tspm1eca/ts-frontend@<sha>/main.js`（失敗再 `raw@sha`）抓；
  3. 內容校驗（含 `ACUVisualizerUI`、非 HTML）後 `(0,eval)` 執行。
- **為什麼用 @sha**：`raw`/`jsdelivr` 的 `@master` 分支 URL 有 CDN 快取（實測 raw 曾卡在舊版 `max-age=300`、`x-cache: HIT`）。@sha 不可變、無此問題。
- **重新載入**（不重整整頁）：找出有 `__ACU_UI_STATUS__` 的 frame，呼叫 `frame.__ACU_UI_RELOAD__()`；查狀態 `frame.__ACU_UI_STATUS__()`（看 `sha`）。frame 索引會變（實測常見 `top.3`）。
- **改了 loader.js 本身**：必須請使用者**重新貼一次**，熱更新換不到 loader。

### 10.1 推送指令（本機 Windows / 憑證管理器）
```bash
cd /d/Downloads/ts-frontend
git add main.js
git -c user.name="ACU UI" -c user.email="acu-ui@local" commit -m "v22.x: ..."   # 需 danger-full-access 寫 .git/index.lock

GIT="/c/Program Files/Git/cmd/git.exe"
GCM="/c/Program Files/Git/mingw64/bin/git-credential-manager.exe"
CRED=$(printf 'protocol=https\nhost=github.com\n\n' | "$GCM" get 2>/dev/null)
U=$(printf '%s\n' "$CRED" | sed -n 's/^username=//p')
P=$(printf '%s\n' "$CRED" | sed -n 's/^password=//p')
B64=$(printf '%s:%s' "$U" "$P" | base64 | tr -d '\n')
GIT_TERMINAL_PROMPT=0 "$GIT" -c credential.helper= \
  -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $B64" push origin master
git ls-remote origin -h refs/heads/master   # 確認遠端 sha
```
> 沙盒內直接 `git push` 常因無 credential helper 失敗；`niugit` 的 schannel 也會 `SEC_E_NO_CREDENTIALS`。用上面的系統 git + GCM token 方式。

---

## 11. 版本變更記錄（與本功能相關）

| 版本 | commit | 重點 |
|---|---|---|
| v21.8 | — | 首版多按鈕（localStorage `acu_manual_buttons_v1`、管理器、動態按鈕、Vue hook） |
| v21.9 | — | 圖標改「按鍵選擇」調色盤（47 個 FontAwesome） |
| v22.0 | — | 跨多層 iframe 找宿主、`#acu-app-v2`；加二次確認 |
| v22.1 | — | 確認氣泡列出「將填寫的表格名」 |
| v22.2 | fa6c249 | 確認改「氣泡」貼按鈕上方；loader 改用 commit SHA 熱更新 |
| v22.3 | 45a1178/4ae51c8/f0f95b3 | 修氣泡跑到左上角（absolute+父容器定位）、表名映射、保留缺失表的 key |
| v22.4 | 2cf1180 | 收合列只有「收合鍵」可切換，點導航條不再切換 |
| v22.5 | 391e29b | 修 hover 白字消失；表名合併多來源（export+template chat/global） |
| v22.6 | 702ae40/50d3fa4 | 擴大 hook 探測（parent/frames、provides 取 pinia、setupState/exposed）；加診斷碼 |
| v22.7 | 01ad64f | **根因修正**：根 VNode 在 `app._container._vnode`，改 `getAppRootVNode` |
| v22.8 | 2113b4b | **移除全局降級**：batch/depth 任一設不到就**中止填表**；兩 setter 都成功才算 ok |
| v22.9 | 95712ec | `uiHint` 改在最外層宿主 window 顯示（修 iframe 內 toastr 看不到），加橫幅後備 |

---

## 12. 給 LLM 的「最小修改邊界」提醒

- 只改 `main.js`，**不要改 index.js**（用戶明確禁止：index.js 不是他的庫）。
- 所有 index.js 依賴集中在 **main.js:2314–2812** 這一段助手區塊；改動請保持：
  - `applyManualFillConfig` 失敗一定要回 `{ok:false, code}`；
  - `runManualButton` 在 `!applied` 時**直接 return、不呼叫 `api.manualUpdate`**；
  - 不要新增任何「退回全局設定」的路徑。
- 每次修改後：`node --check main.js` → 版本 +0.1 → commit/push → 用第 9 節驗證。
- 若 index.js 大改（Vue 換版本、pinia 不用、`#acu-app-v2` 消失），則需重寫 `findAcuV2App` / `findManualUpdateApiInVNode` / `getAppRootVNode` 三個函式，其餘 UI 與流程可保留。
