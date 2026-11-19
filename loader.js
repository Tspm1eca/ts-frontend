// 把這個檔案的內容貼進酒館腳本一次即可。
// 熱更新原理：先用 GitHub API 解析 master 最新 commit SHA，再「按 SHA」抓 main.js。
//   → 按 SHA 的網址是不可變的，新 commit 就是新網址，永遠不會讀到舊快取。
//   → API 請求帶 ETag，內容沒變時回 304，不計入未登入 60 次/小時的限制。
// 若 API 連不上，才退而用 jsDelivr 的 @master（push 後會自動清快取），最後才是 raw @master。
(async function () {
    'use strict';

    const REPO = 'Tspm1eca/ts-frontend';
    const BRANCH = 'master';
    const FILE = 'main.js';
    const MIN_INTERVAL_MS = 30 * 1000;   // 同一頁面內兩次檢查最短間隔（force 不受限）
    const TIMEOUT_MS = 15000;
    const book = window;
    const TAG = '[ACU UI]';

    // localStorage 可能被沙盒 iframe 禁用，全部包 try
    const ls = {
        get(k) { try { return book.localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { book.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    };

    const sigOf = (text) => {
        let h = 5381;
        for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
        return text.length + ':' + (h >>> 0).toString(16);
    };

    const fetchWithTimeout = async (url, opts) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            return await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
        } finally {
            clearTimeout(timer);
        }
    };

    const fetchText = async (url) => {
        // no-store：連瀏覽器快取都不使用；搭配「按 SHA」網址可確保拿到該 commit 的真實內容
        const res = await fetchWithTimeout(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
    };

    // 擋掉被 CDN／代理換成的錯誤頁（HTML、限流頁等），避免把垃圾丟進 eval
    const looksLikeMainJs = (t) =>
        !!t && t.length > 2000 &&
        t.indexOf('ACUVisualizerUI') !== -1 &&
        t.indexOf('<html') === -1 &&
        t.indexOf('<!DOCTYPE') === -1;

    const uiExists = () => {
        if (book.ACUVisualizerUI) return true;
        try {
            const p = window.parent;
            return !!(p && p !== window && p.ACUVisualizerUI);
        } catch (e) {
            return false; // 跨域 parent，忽略
        }
    };

    // 解析 master 最新 commit SHA（帶 ETag，304 免費）
    async function resolveLatestSha() {
        const headers = { 'Accept': 'application/vnd.github+json' };
        const etag = ls.get('acu_ui_gh_etag');
        if (etag) headers['If-None-Match'] = etag;

        const res = await fetchWithTimeout(
            `https://api.github.com/repos/${REPO}/commits/${BRANCH}`,
            { cache: 'no-store', headers }
        );
        if (res.status === 304) return ls.get('acu_ui_gh_sha') || null;
        if (!res.ok) throw new Error('API HTTP ' + res.status);

        const newEtag = res.headers.get('etag');
        if (newEtag) ls.set('acu_ui_gh_etag', newEtag);

        const data = await res.json();
        const sha = data && data.sha;
        if (sha) ls.set('acu_ui_gh_sha', sha);
        return sha || null;
    }

    function buildSources(sha) {
        const list = [];
        if (sha) {
            // 首選：按 commit SHA 取，永久不可變、一定是最新
            list.push({ name: 'jsdelivr@sha', url: `https://cdn.jsdelivr.net/gh/${REPO}@${sha}/${FILE}` });
            list.push({ name: 'raw@sha', url: `https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}` });
        }
        // 備援：jsDelivr 的 @master 在 push 後會清快取，通常比 raw 的分支快取新
        list.push({ name: 'jsdelivr@master', url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${FILE}` });
        list.push({ name: 'raw@master', url: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}` });
        list.push({ name: 'ghproxy', url: `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}` });
        return list;
    }

    async function loadLatest(force) {
        if (book.__ACU_UI_LOADING__) return false;

        const now = Date.now();
        if (!force && book.__ACU_UI_LAST_CHECK__ && now - book.__ACU_UI_LAST_CHECK__ < MIN_INTERVAL_MS) return false;
        book.__ACU_UI_LAST_CHECK__ = now;
        book.__ACU_UI_LOADING__ = true;

        try {
            let sha = null;
            try {
                sha = await resolveLatestSha();
            } catch (e) {
                console.warn(`${TAG} 無法解析最新 commit，改用分支來源：`, e && e.message);
            }

            // 快路徑：SHA 沒變、而且 UI 已經在，直接略過（省下約 300KB 下載）
            if (!force && sha && sha === book.__ACU_UI_SHA__ && book.__ACU_UI_SIG__ && uiExists()) {
                console.info(`${TAG} 已是最新（${sha.slice(0, 7)}）`);
                return false;
            }

            let code = null;
            let used = null;
            let lastError = null;

            for (const src of buildSources(sha)) {
                try {
                    const text = await fetchText(src.url);
                    if (looksLikeMainJs(text)) {
                        code = text;
                        used = src.name;
                        break;
                    }
                    lastError = new Error('內容看起來不是 main.js（可能被快取或代理攔截）');
                    console.warn(`${TAG} 來源 ${src.name} 內容無效，換下一個`);
                } catch (e) {
                    lastError = e;
                    console.warn(`${TAG} 來源 ${src.name} 失敗：`, e && e.message);
                }
            }

            if (!code) {
                throw new Error('所有來源都取不到 ' + FILE + '（最後錯誤：' + (lastError && lastError.message) + '）');
            }

            const sig = sigOf(code);
            if (sig === book.__ACU_UI_SIG__ && uiExists()) {
                if (sha) book.__ACU_UI_SHA__ = sha;
                console.info(`${TAG} 已是最新 ${sig}`);
                return false;
            }

            (0, eval)(code + '\n//# sourceURL=acu-visualizer-ui/' + sig.replace(':', '_') + '/main.js');

            // main.js 執行完一定會註冊 ACUVisualizerUI；沒有就代表它在初始化階段就拋錯了
            if (!uiExists()) {
                throw new Error('main.js 執行完但沒有註冊 ACUVisualizerUI（多半是 main.js 內部初始化就拋錯）');
            }

            book.__ACU_UI_SIG__ = sig;
            if (sha) book.__ACU_UI_SHA__ = sha;
            book.__ACU_UI_LOADED_AT__ = now;
            console.info(`${TAG} 已載入 ${sig}（來源：${used}${sha ? '，commit ' + sha.slice(0, 7) : ''}）`);
            return true;
        } finally {
            book.__ACU_UI_LOADING__ = false;
        }
    }

    // 手動強制重載：console 打 __ACU_UI_RELOAD__()
    book.__ACU_UI_RELOAD__ = () => loadLatest(true);
    // 診斷目前狀態：console 打 __ACU_UI_STATUS__()
    book.__ACU_UI_STATUS__ = () => ({
        sig: book.__ACU_UI_SIG__ || null,
        sha: book.__ACU_UI_SHA__ || null,
        loadedAt: book.__ACU_UI_LOADED_AT__ || null,
        lastCheck: book.__ACU_UI_LAST_CHECK__ || null,
        uiExists: uiExists(),
        apiEtag: ls.get('acu_ui_gh_etag') || null
    });

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
