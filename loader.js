// 把這個檔案的內容貼進酒館腳本一次即可。
// 熱更新原理：直接抓 raw 上的 main.js，用「內容雜湊」判斷有沒有變。
// 完全不呼叫 api.github.com，因此不受「未登入 60 次/小時/IP」限制。
(async function () {
    'use strict';

    const REPO = 'Tspm1eca/ts-frontend';
    const BRANCH = 'master';
    const FILE = 'main.js';
    const MIN_INTERVAL_MS = 60 * 1000;   // 兩次檢查最短間隔，避免重複觸發時打爆來源
    const TIMEOUT_MS = 15000;
    const book = window;
    const TAG = '[ACU UI]';

    // 依序嘗試；前一個失敗才換下一個。
    // raw 最新最快；jsDelivr 當備援（branch 有約 12 小時快取）；ghproxy 給連不上 GitHub 的網路。
    const SOURCES = [
        { name: 'raw', url: () => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}` },
        { name: 'jsdelivr', url: () => `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${FILE}` },
        { name: 'ghproxy', url: () => `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}` },
    ];

    const sigOf = (text) => {
        let h = 5381;
        for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
        return text.length + ':' + (h >>> 0).toString(16);
    };

    const fetchText = async (url) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            // no-cache = 每次都跟伺服器驗證；內容沒變時走 304，不會真的重下 267KB
            const res = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.text();
        } finally {
            clearTimeout(timer);
        }
    };

    const uiExists = () => {
        if (book.ACUVisualizerUI) return true;
        try {
            const p = window.parent;
            return !!(p && p !== window && p.ACUVisualizerUI);
        } catch (e) {
            return false; // 跨域 parent，忽略
        }
    };

    async function loadLatest(force) {
        if (book.__ACU_UI_LOADING__) return false;

        const now = Date.now();
        if (!force && book.__ACU_UI_LAST_CHECK__ && now - book.__ACU_UI_LAST_CHECK__ < MIN_INTERVAL_MS) return false;
        book.__ACU_UI_LAST_CHECK__ = now;
        book.__ACU_UI_LOADING__ = true;

        try {
            let code = null;
            let used = null;
            let lastError = null;

            for (const src of SOURCES) {
                try {
                    const text = await fetchText(src.url());
                    if (text && text.length > 0) {
                        code = text;
                        used = src.name;
                        break;
                    }
                } catch (e) {
                    lastError = e;
                    console.warn(`${TAG} 來源 ${src.name} 失敗：`, e && e.message);
                }
            }

            if (!code) {
                throw new Error('所有來源都取不到 ' + FILE + '（最後錯誤：' + (lastError && lastError.message) + '）');
            }

            const sig = sigOf(code);
            if (sig === book.__ACU_UI_SIG__) {
                console.info(`${TAG} 已是最新 ${sig}`);
                return false;
            }

            (0, eval)(code + '\n//# sourceURL=acu-visualizer-ui/' + sig.replace(':', '_') + '/main.js');

            // main.js 執行完一定會註冊 ACUVisualizerUI；沒有就代表它在初始化階段就拋錯了
            if (!uiExists()) {
                throw new Error('main.js 執行完但沒有註冊 ACUVisualizerUI（多半是 main.js 內部初始化就拋錯）');
            }

            book.__ACU_UI_SIG__ = sig;
            console.info(`${TAG} 已載入 ${sig}（來源：${used}）`);
            return true;
        } finally {
            book.__ACU_UI_LOADING__ = false;
        }
    }

    // 手動強制重載：console 打 __ACU_UI_RELOAD__()
    book.__ACU_UI_RELOAD__ = () => loadLatest(true);

    try {
        await loadLatest(false);
    } catch (error) {
        console.error(`${TAG} 熱更新失敗：`, error);
    }

    // 回到前景時再檢查一次（有 MIN_INTERVAL_MS 節流，不會濫發請求）
    if (!book.__ACU_UI_WATCHING__) {
        book.__ACU_UI_WATCHING__ = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                loadLatest(false).catch((error) => console.warn(`${TAG} 檢查更新失敗：`, error));
            }
        });
    }
})();
