/**
 * util.js · 公共小工具：HTML 转义 + 浏览器原生发音
 */

export function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

let enVoice = null;

function pickVoice() {
    if (enVoice) return enVoice;
    const voices = window.speechSynthesis?.getVoices() || [];
    enVoice = voices.find(v => v.lang === 'en-US')
        || voices.find(v => v.lang?.startsWith('en'))
        || null;
    return enVoice;
}

// voices 是异步加载的，提前触发 + 监听
if (window.speechSynthesis) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = () => { enVoice = null; pickVoice(); };
}

/** 浏览器原生 TTS 读单词（用户手势内调用，无请求无依赖） */
export function speak(text) {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 0.9;
    window.speechSynthesis.speak(u);
}
