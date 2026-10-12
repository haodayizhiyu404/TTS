(async () => {
'use strict';

const TTS_VERSION = '1.1.0';
/**
 * ============================================================
 *  多角色分音色 TTS · UI 版（Edge TTS）
 *  适配：JS-Slash-Runner（酒馆助手）脚本环境
 * ------------------------------------------------------------
 *  功能：
 *  1. AI 消息完成后，按【人名】：对话 格式解析多人对话
 *  2. 每个角色使用各自绑定的 Edge 音色，逐段独立发声
 *  3. 自动跳过 user / 系统消息；用户发新消息自动打断
 *  4. 右下角悬浮按钮：🔊 开关 TTS / ⚙️ 打开设置面板
 *  5. 设置面板：角色名+音色可视化绑定、试听、语速、
 *     配置持久化到脚本数据（导出角色卡时自动携带）
 * ------------------------------------------------------------
 *  前置条件（脚本设置面板里会自动检测状态）：
 *  酒馆本身不会变声，需要下面二选一作为"发声后端"：
 *  A. SillyTavern-EdgeTTS-Plugin（酒馆服务端插件，推荐）
 *     https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin
 *  B. Extras API（独立 Python 服务），config.yaml 的
 *     enable-modules 中加入 edge-tts
 * ============================================================
 */

// ===================== 默认配置（仅首次运行使用） =====================

const DEFAULT_CONFIG = {
    voiceMap: {},        // { 角色名: Edge音色ID }，在设置面板里添加
    narratorVoice: null, // 旁白音色，null = 不朗读旁白
    rate: 0,             // 语速 -50 ~ +50
    enabled: true,
};

const CONFIG_KEY = 'multiTtsConfig';
const PANEL_ID = 'multi-tts-panel';

// ===================== 环境 =====================

const SillyTavern = window.parent.SillyTavern;
const parentDoc = window.parent.document;
const sampleText = 'Hey! This is a voice preview. Nice to meet you!';

let config = loadConfig();
let backend = null;   // 'plugin' | 'extras' | null
let voiceList = [];   // [{ name, locale }]
let playingPreview = null;

// ---------- 配置读写（脚本数据，随卡导出） ----------

function loadConfig() {
    try {
        const saved = getVariables({ type: 'script' })[CONFIG_KEY];
        if (saved && typeof saved === 'object') {
            return {
                ...DEFAULT_CONFIG, ...saved,
                voiceMap: { ...DEFAULT_CONFIG.voiceMap, ...(saved.voiceMap || {}) },
            };
        }
    } catch (e) {
        console.warn('[MultiTTS] 读取配置失败，使用默认值', e);
    }
    return { ...DEFAULT_CONFIG, voiceMap: {} };
}

function saveConfig() {
    insertOrAssignVariables({ [CONFIG_KEY]: config }, { type: 'script' });
}

// ---------- Edge TTS 后端探测 ----------

// 酒馆的 POST 接口有 CSRF 防护（csrf-sync），token 从 /csrf-token 获取，
// 与会话 cookie 绑定，获取一次即可复用
let csrfToken = null;
async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    try {
        const r = await fetch('/csrf-token');
        if (r.ok) csrfToken = (await r.json()).token;
    } catch (e) { /* CSRF 被禁用或服务不可达时保持 null */ }
    return csrfToken;
}

async function detectBackend() {
    if (backend) return backend;
    const headers = { 'X-CSRF-Token': await getCsrfToken() };
    try {
        const r = await fetch('/api/plugins/edge-tts/probe', { method: 'POST', headers: headers });
        if (r.ok) { backend = 'plugin'; return backend; }
    } catch (e) { /* 继续探测 */ }
    try {
        const r = await fetch('/api/edge-tts/list');
        if (r.ok) { backend = 'extras'; return backend; }
    } catch (e) { /* 都不通 */ }
    backend = null;
    return null;
}

function voiceListUrl() {
    return backend === 'plugin' ? '/api/plugins/edge-tts/list' : '/api/edge-tts/list';
}

function generateUrl() {
    return backend === 'plugin' ? '/api/plugins/edge-tts/generate' : '/api/edge-tts/generate';
}

async function fetchVoiceList() {
    await detectBackend();
    if (!backend) return [];
    const r = await fetch(voiceListUrl());
    if (!r.ok) return [];
    const json = await r.json();
    return json
        .map(v => ({ name: v.ShortName ?? v.voice_id ?? v.name, locale: v.Locale ?? v.lang ?? '' }))
        .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
}

async function synth(text, voice) {
    const r = await fetch(generateUrl(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': await getCsrfToken(),
        },
        body: JSON.stringify({ text: text, voice: voice, rate: Number(config.rate) }),
    });
    if (!r.ok) throw new Error(`TTS 合成失败: HTTP ${r.status}`);
    return await r.blob();
}

// ---------- 文本解析：拆出【人名】：对话 ----------

function cleanText(t) {
    return t
        .replace(/\*[^*\n]*\*/g, ' ')     // 动作描写 *asterisks*
        .replace(/[ \t]*\n+[ \t]*/g, ' ') // 换行压成空格
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function parseSegments(text) {
    const marks = [];
    const re = /【\s*([^\]【]{1,30}?)\s*】\s*[:：]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        marks.push({ name: m[1].trim(), contentStart: re.lastIndex, index: m.index });
    }

    const segs = [];
    if (marks.length === 0) {
        const t = cleanText(text);
        if (t) segs.push({ name: null, text: t });
        return segs;
    }
    if (marks[0].index > 0) {
        const t = cleanText(text.slice(0, marks[0].index));
        if (t) segs.push({ name: null, text: t });
    }
    for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
        const t = cleanText(text.slice(marks[i].contentStart, end));
        if (t) segs.push({ name: marks[i].name, text: t });
    }
    return segs;
}

function voiceFor(name) {
    if (name === null || name === undefined) return config.narratorVoice;
    return config.voiceMap[name] ?? null; // 没绑音色的角色直接跳过
}

// ---------- 播放队列 ----------

const queue = [];
let currentAudio = null;
let isPlaying = false;
let prefetchPromise = null;
let prefetchFor = null;

function playBlob(blob) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const audio = new window.parent.Audio(); // 在父页面播放，继承自动播放权限
        currentAudio = audio;
        audio.src = url;
        const done = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; resolve(); };
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
    });
}

async function enqueueMessage(segments) {
    for (const seg of segments) {
        const voice = voiceFor(seg.name);
        if (!voice) continue;
        queue.push({ name: seg.name, text: seg.text, voice: voice });
    }
    if (!isPlaying) pump();
}

async function pump() {
    const item = queue.shift();
    if (!item) { isPlaying = false; return; }
    isPlaying = true;
    try {
        const blob = (prefetchPromise && prefetchFor === item)
            ? await prefetchPromise
            : await synth(item.text, item.voice);
        prefetchPromise = null;
        prefetchFor = null;

        // 边播边预取下一小段，减少角色之间的停顿
        if (queue.length > 0) {
            const next = queue[0];
            prefetchFor = next;
            prefetchPromise = synth(next.text, next.voice).catch(() => null);
        }
        if (blob) await playBlob(blob);
    } catch (e) {
        console.error('[MultiTTS]', e);
    }
    pump();
}

function stopAll() {
    queue.length = 0;
    prefetchPromise = null;
    prefetchFor = null;
    if (currentAudio) {
        const audio = currentAudio;
        currentAudio = null;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
    }
    isPlaying = false;
}

// ---------- 事件挂钩 ----------

function hookEvents() {
    eventOn(tavern_events.MESSAGE_RECEIVED, async (messageIndex) => {
        if (!config.enabled) return;
        if (!(await detectBackend())) {
            notify('Edge TTS 后端不可用：请安装 EdgeTTS 插件或在 Extras 中启用 edge-tts', 'warning', 5000);
            return;
        }
        const ctx = SillyTavern.getContext();
        const msg = typeof messageIndex === 'number' ? ctx.chat[messageIndex] : ctx.chat[ctx.chat.length - 1];
        if (!msg || msg.is_user || msg.is_system) return;

        const segments = parseSegments(msg.mes);
        if (segments.length === 0) return;
        enqueueMessage(segments);
    });

    // 用户发送新消息 → 打断
    eventOn(tavern_events.GENERATION_STARTED, () => stopAll());
}

// ---------- 悬浮按钮 ----------

function notify(msg, type = 'info', timeout = 2500) {
    try { toastr[type](msg, 'MultiTTS', { timeOut: timeout }); }
    catch (e) { console.warn('[MultiTTS]', msg); }
}

function createFloatButtons() {
    if (parentDoc.getElementById('multi-tts-float')) return;
    const cssId = 'multi-tts-styles';
    if (!parentDoc.getElementById(cssId)) {
        const style = parentDoc.createElement('style');
        style.id = cssId;
        style.textContent = `
            #multi-tts-float { position: fixed; right: 16px; bottom: 90px; z-index: 9999;
                display: flex; flex-direction: column; gap: 6px; user-select: none; }
            #multi-tts-float .mtts-btn { padding: 6px 10px; border-radius: 8px; cursor: pointer;
                background: #2b2b3a; color: #fff; font-size: 14px; opacity: 0.85; text-align: center; }
            #multi-tts-float .mtts-btn:hover { opacity: 1; }
            #multi-tts-float .mtts-on { background: #2b6cb0; }
            #multi-tts-panel { position: fixed; right: 16px; bottom: 160px; z-index: 10000;
                width: 460px; max-height: 70vh; overflow-y: auto; padding: 14px 16px;
                background: #1e1e2a; color: #e8e8ef; border: 1px solid #444;
                border-radius: 10px; font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
            #multi-tts-panel h3 { margin: 0 0 4px; font-size: 15px; }
            #multi-tts-panel .mtts-row { display: flex; gap: 6px; margin: 6px 0; align-items: center; }
            #multi-tts-panel input[type=text] { flex: 1; min-width: 90px; background: #2b2b3a;
                border: 1px solid #555; color: #fff; border-radius: 6px; padding: 4px 8px; }
            #multi-tts-panel select { flex: 2; background: #2b2b3a; border: 1px solid #555;
                color: #fff; border-radius: 6px; padding: 4px; max-width: 260px; }
            #multi-tts-panel button { background: #2b6cb0; color: #fff; border: none;
                border-radius: 6px; padding: 4px 10px; cursor: pointer; }
            #multi-tts-panel button.mtts-del { background: #8b3a3a; padding: 4px 8px; }
            #multi-tts-panel button.mtts-ghost { background: #444; }
            #multi-tts-panel .mtts-status { font-size: 12px; opacity: 0.8; margin: 4px 0 8px; }
            #multi-tts-panel label { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
            #multi-tts-panel .mtts-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
        `;
        parentDoc.head.appendChild(style);
    }

    const wrap = parentDoc.createElement('div');
    wrap.id = 'multi-tts-float';
    wrap.innerHTML = `
        <div class="mtts-btn" id="mtts-toggle" title="开关 TTS（播放中点击=立即停止）">🔊</div>
        <div class="mtts-btn" id="mtts-settings" title="音色设置">⚙️</div>
    `;
    parentDoc.body.appendChild(wrap);

    const toggleBtn = wrap.querySelector('#mtts-toggle');
    const refreshToggle = () => { toggleBtn.classList.toggle('mtts-on', config.enabled); };
    refreshToggle();

    toggleBtn.onclick = () => {
        if (currentAudio || queue.length > 0) { stopAll(); notify('已停止播放', 'info', 1200); return; }
        config.enabled = !config.enabled;
        saveConfig();
        refreshToggle();
        notify(config.enabled ? 'TTS 已开启' : 'TTS 已关闭', 'info', 1200);
    };
    wrap.querySelector('#mtts-settings').onclick = () => openPanel();
}

// ---------- 设置面板 ----------

function voiceOptionsHtml(selected, includeNone) {
    let html = includeNone ? `<option value="">（不朗读）</option>` : '';
    for (const v of voiceList) {
        html += `<option value="${v.name}" ${v.name === selected ? 'selected' : ''}>${v.name}</option>`;
    }
    return html;
}

async function openPanel() {
    const old = parentDoc.getElementById(PANEL_ID);
    if (old) { old.remove(); return; } // 再点一次关闭

    const panel = parentDoc.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `<h3>多角色 TTS 设置</h3><div class="mtts-status">正在检测 Edge TTS 后端…</div>`;
    parentDoc.body.appendChild(panel);

    // 后端 + 音色列表（面板打开时才加载，缓存复用）
    if (voiceList.length === 0) {
        await detectBackend();
        if (backend) {
            try { voiceList = await fetchVoiceList(); } catch (e) { voiceList = []; }
        }
    }

    const statusEl = panel.querySelector('.mtts-status');
    if (!backend) {
        statusEl.innerHTML = '❌ 后端不可用。需要二选一：<br>' +
            '① 安装 SillyTavern-EdgeTTS-Plugin（服务端插件）<br>' +
            '② Extras API 的 enable-modules 中加入 edge-tts';
    } else {
        statusEl.textContent = `✅ 后端正常（${backend === 'plugin' ? 'EdgeTTS 插件' : 'Extras'}），共 ${voiceList.length} 个音色`;
    }

    // 角色名由用户手输：必须是故事里的人物名（和世界书输出格式里的名字一致），
    // 与角色卡标题无关，无法自动枚举
    const rowsHtml = Object.entries(config.voiceMap).map(([name, voice]) => rowHtml(name, voice)).join('');
    panel.insertAdjacentHTML('beforeend', `
        <div id="mtts-rows">${rowsHtml}</div>
        <div class="mtts-row">
            <button class="mtts-ghost" id="mtts-add">＋ 添加角色</button>
        </div>
        <div class="mtts-row">
            <span style="flex:1">旁白（未匹配到人名的文本）</span>
            <select id="mtts-narrator">${voiceOptionsHtml(config.narratorVoice, true)}</select>
            <button class="mtts-ghost mtts-preview-n">🔊</button>
        </div>
        <label>语速 <span id="mtts-rate-out">${config.rate}</span>
            <input type="range" id="mtts-rate" min="-50" max="50" step="5" value="${config.rate}" style="flex:1">
        </label>
        <label><input type="checkbox" id="mtts-enabled" ${config.enabled ? 'checked' : ''}> 启用自动朗读</label>
        <div class="mtts-foot">
            <button class="mtts-ghost" id="mtts-cancel">关闭</button>
            <button id="mtts-save">保存</button>
        </div>
    `);

    function rowHtml(name, voice) {
        return `<div class="mtts-row mtts-vrow">
            <input type="text" class="mtts-name" placeholder="故事内角色名" value="${escapeHtml(name)}">
            <select class="mtts-voice">${voiceOptionsHtml(voice, false)}</select>
            <button class="mtts-ghost mtts-preview">🔊</button>
            <button class="mtts-del">✕</button>
        </div>`;
    }

    // 行内事件：试听 / 删除
    panel.querySelectorAll('.mtts-vrow').forEach(row => {
        row.querySelector('.mtts-preview').onclick = () => preview(row.querySelector('.mtts-voice').value);
        row.querySelector('.mtts-del').onclick = () => row.remove();
    });
    panel.querySelector('.mtts-preview-n').onclick = () => preview(panel.querySelector('#mtts-narrator').value);

    panel.querySelector('#mtts-add').onclick = () => {
        if (!backend) { notify('后端不可用，无法添加', 'warning'); return; }
        panel.querySelector('#mtts-rows').insertAdjacentHTML('beforeend', rowHtml('', voiceList[0]?.name ?? ''));
        const row = panel.querySelector('#mtts-rows').lastElementChild;
        row.querySelector('.mtts-preview').onclick = () => preview(row.querySelector('.mtts-voice').value);
        row.querySelector('.mtts-del').onclick = () => row.remove();
    };

    panel.querySelector('#mtts-rate').oninput = (e) => {
        panel.querySelector('#mtts-rate-out').textContent = e.target.value;
    };

    panel.querySelector('#mtts-cancel').onclick = () => panel.remove();
    panel.querySelector('#mtts-save').onclick = () => {
        const voiceMap = {};
        let dup = false, empty = false;
        panel.querySelectorAll('.mtts-vrow').forEach(row => {
            const name = row.querySelector('.mtts-name').value.trim();
            const voice = row.querySelector('.mtts-voice').value;
            if (!name) { empty = true; return; }
            if (voiceMap[name]) dup = true;
            voiceMap[name] = voice;
        });
        if (dup) { notify('有重复的角色名，已保留最后一行', 'warning'); }
        config.voiceMap = voiceMap;
        config.narratorVoice = panel.querySelector('#mtts-narrator').value || null;
        config.rate = Number(panel.querySelector('#mtts-rate').value);
        config.enabled = panel.querySelector('#mtts-enabled').checked;
        saveConfig();
        refreshToggleState();
        notify('已保存', 'success', 1500);
        panel.remove();
    };

    function refreshToggleState() {
        const t = parentDoc.getElementById('mtts-toggle');
        if (t) t.classList.toggle('mtts-on', config.enabled);
    }
}

async function preview(voice) {
    if (!voice) { notify('请先选择音色', 'warning', 1200); return; }
    if (!backend && !(await detectBackend())) { notify('后端不可用', 'warning'); return; }
    try {
        if (playingPreview) { playingPreview.pause(); playingPreview = null; }
        const blob = await synth(sampleText, voice);
        const url = URL.createObjectURL(blob);
        const audio = new window.parent.Audio();
        playingPreview = audio;
        audio.src = url;
        audio.onended = () => { URL.revokeObjectURL(url); if (playingPreview === audio) playingPreview = null; };
        audio.play().catch(() => {});
    } catch (e) {
        notify('试听失败：' + e.message, 'error');
    }
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// ---------- 启动 ----------

await detectBackend();
hookEvents();
createFloatButtons();

if (!backend) {
    notify('Edge TTS 后端不可用：请安装 EdgeTTS 插件或在 Extras 中启用 edge-tts（点 ⚙️ 查看说明）', 'warning', 8000);
} else {
    console.info(`[MultiTTS] v${TTS_VERSION} 已加载，后端: ${backend}`);
}

})();
