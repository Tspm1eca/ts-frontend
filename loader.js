// 把這個檔案的內容貼進酒館腳本一次即可。
(async function () {
    'use strict';

    const REPO = 'Tspm1eca/ts-frontend';
    const BRANCH = 'master';
    const FILE = 'main.js';
    const book = window;

    async function loadLatest() {
        if (book.__ACU_UI_LOADING__) return;
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
})();
