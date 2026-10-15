// 把這個檔案的內容貼進酒館腳本一次即可。
// 之後只推送 main.js。開啟頁面時會載入最新版，之後約每 2 分鐘再檢查一次。
(async function () {
    'use strict';

    const REPO = 'Tspm1eca/ts-frontend';
    const BRANCH = 'master';
    const FILE = 'main.js';
    const CHECK_INTERVAL_MS = 2 * 60 * 1000;
    const MIN_GAP_MS = 60 * 1000;
    const book = window;

    async function loadLatest() {
        if (book.__ACU_UI_LOADING__) return;
        const now = Date.now();
        if (book.__ACU_UI_LAST_CHECK__ && now - book.__ACU_UI_LAST_CHECK__ < MIN_GAP_MS) return;
        book.__ACU_UI_LAST_CHECK__ = now;
        book.__ACU_UI_LOADING__ = true;
        try {
            const metaRes = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { cache: 'no-store' });
            if (!metaRes.ok) throw new Error('版本查詢失敗: ' + metaRes.status);
            const sha = (await metaRes.json()).sha;
            if (!sha || sha === book.__ACU_UI_SHA__) return;

            const codeRes = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}`, { cache: 'no-store' });
            if (!codeRes.ok) throw new Error('腳本下載失敗: ' + codeRes.status);
            const code = await codeRes.text();
            (0, eval)(code + '\n//# sourceURL=acu-visualizer-ui/' + sha.slice(0, 7) + '/main.js');
            book.__ACU_UI_SHA__ = sha;
            console.info('[ACU UI] 已載入', sha.slice(0, 7));
        } finally {
            book.__ACU_UI_LOADING__ = false;
        }
    }

    try {
        await loadLatest();
    } catch (error) {
        console.error('[ACU UI] 熱更新失敗:', error);
    }

    if (!book.__ACU_UI_WATCHING__) {
        book.__ACU_UI_WATCHING__ = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                loadLatest().catch((error) => console.warn('[ACU UI] 檢查更新失敗:', error));
            }
        });
        book.__ACU_UI_TIMER__ = setInterval(() => {
            loadLatest().catch((error) => console.warn('[ACU UI] 檢查更新失敗:', error));
        }, CHECK_INTERVAL_MS);
    }
})();
