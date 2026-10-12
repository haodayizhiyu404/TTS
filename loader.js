/**
 * ============================================================
 *  多角色分音色 TTS · 远程加载器（酒馆助手脚本）
 * ------------------------------------------------------------
 *  用法：把【本文件全文】粘贴进酒馆助手（JS-Slash-Runner）新建脚本，
 *        并绑定到角色卡。真正的功能代码在 GitHub 仓库：
 *        https://github.com/haodayizhiyu404/TTS
 *        更新功能只需 push 仓库，所有用户重新进聊天即自动生效，
 *        无需重新粘贴。
 *  原理：按顺序尝试多个 CDN 源 fetch 本体的 JS → eval 执行。
 * ============================================================
 */

const TTS_SOURCES = [
    'https://raw.githubusercontent.com/haodayizhiyu404/TTS/main/multi-char-tts.js',
    'https://cdn.jsdelivr.net/gh/haodayizhiyu404/TTS@main/multi-char-tts.js',
    'https://mirror.ghproxy.com/https://raw.githubusercontent.com/haodayizhiyu404/TTS/main/multi-char-tts.js',
];

let ttsCode = null;
for (const url of TTS_SOURCES) {
    try {
        const sep = url.includes('?') ? '&' : '?';
        const r = await fetch(url + sep + 't=' + Date.now(), { cache: 'no-store' });
        if (r.ok) { ttsCode = await r.text(); break; }
    } catch (e) {
        console.warn('[MultiTTS] 源不可达：' + url, e);
    }
}

if (!ttsCode) {
    toastr.error('MultiTTS 加载失败：所有源都无法访问，请检查网络/代理', 'MultiTTS', { timeOut: 8000 });
} else {
    // 直接 eval：让本体代码跑在沙箱作用域内（能拿到 eventOn/getVariables 等）
    eval(ttsCode);
}
