/**
 * Multi-Char TTS · 多角色分音色朗读（独立扩展版）
 * ------------------------------------------------------------
 * 功能：
 * 1. 聊天中每句【人名】：“English.”（中文翻译）后渲染 🔊，点击朗读本句英文
 * 2. 引擎可切换：Fish Audio（经酒馆 /proxy 转发，需 enableCorsProxy）
 *    或 Edge TTS（需 EdgeTTS 服务端插件或 Extras）
 * 3. 每个角色独立绑定音色，旁白可选，自动朗读可选（默认关）
 * ------------------------------------------------------------
 * 配置项全部在 插件管理 → Multi-Char TTS 面板里。
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';

const EXTENSION_NAME = 'multi-char-tts';
const VERSION = '2.0.2';

const DEFAULT_SETTINGS = {
    provider: 'fish',        // 'fish' | 'edge'
    fishKey: '',             // Fish Audio API key
    fishModel: 's2.1-pro-free',
    speed: 1,                // Fish 语速 0.5~1.5（Edge 模式用 rate）
    rate: 0,                 // Edge 语速 -50~+50
    enabled: false,          // 自动朗读
    voiceMap: {},            // { 故事内角色名: 音色ID / Edge音色名 }
    narratorVoice: '',       // 旁白音色，空 = 不朗读
};

let settings = {};
let edgeVoices = [];         // [{ name, locale }]
let edgeBackend = null;      // 'plugin' | 'extras' | null
const sampleText = 'Hey! This is a voice preview. Nice to meet you!';

function loadSettings() {
    extension_settings[EXTENSION_NAME] = Object.assign(
        {}, DEFAULT_SETTINGS, extension_settings[EXTENSION_NAME],
    );
    settings = extension_settings[EXTENSION_NAME];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ==================== 后端：Fish / Edge ====================

async function synthFish(text, voice) {
    const r = await fetch('/proxy/https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.fishKey}`,
            'model': settings.fishModel || 's2.1-pro-free',
        },
        body: JSON.stringify({
            text: text,
            reference_id: voice,
            format: 'mp3',
            prosody: { speed: Number(settings.speed) || 1 },
        }),
    });
    if (!r.ok) {
        const detail = (await r.text()).slice(0, 120);
        throw new Error(`Fish TTS HTTP ${r.status}: ${detail}`);
    }
    return await r.blob();
}

async function detectEdgeBackend() {
    if (edgeBackend) return edgeBackend;
    const headers = getRequestHeaders();
    try {
        const r = await fetch('/api/plugins/edge-tts/probe', { method: 'POST', headers: headers });
        if (r.ok) { edgeBackend = 'plugin'; return edgeBackend; }
    } catch (e) { /* 继续探测 */ }
    try {
        const r = await fetch('/api/edge-tts/list');
        if (r.ok) { edgeBackend = 'extras'; return edgeBackend; }
    } catch (e) { /* 都不通 */ }
    edgeBackend = null;
    return null;
}

async function fetchEdgeVoices() {
    if (edgeVoices.length > 0) return edgeVoices;
    if (!(await detectEdgeBackend())) return [];
    const url = edgeBackend === 'plugin' ? '/api/plugins/edge-tts/list' : '/api/edge-tts/list';
    const r = await fetch(url);
    if (!r.ok) return [];
    const json = await r.json();
    edgeVoices = json
        .map(v => ({ name: v.ShortName ?? v.voice_id ?? v.name, locale: v.Locale ?? v.lang ?? '' }))
        .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
    return edgeVoices;
}

async function synthEdge(text, voice) {
    await detectEdgeBackend();
    if (!edgeBackend) throw new Error('Edge TTS 后端不可用');
    const url = edgeBackend === 'plugin' ? '/api/plugins/edge-tts/generate' : '/api/edge-tts/generate';
    const r = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ text: text, voice: voice, rate: Number(settings.rate) }),
    });
    if (!r.ok) throw new Error(`Edge TTS HTTP ${r.status}`);
    return await r.blob();
}

async function synth(text, voice) {
    if (settings.provider === 'fish') return await synthFish(text, voice);
    return await synthEdge(text, voice);
}

async function backendReady() {
    if (settings.provider === 'fish') {
        if (!settings.fishKey) {
            notify('还没填 Fish Audio API key（插件管理 → Multi-Char TTS）', 'warning', 4000);
            return false;
        }
        return true;
    }
    if (!(await detectEdgeBackend())) {
        notify('Edge TTS 后端不可用：需安装 EdgeTTS 插件或在 Extras 中启用 edge-tts', 'warning', 5000);
        return false;
    }
    return true;
}

// ==================== 格式解析 ====================

const LINE_RE = /【\s*([^\]【]{1,30}?)\s*】\s*[:：]/g;

function cleanText(t) {
    return t
        .replace(/\*[^*\n]*\*/g, ' ')
        .replace(/[ \t]*\n+[ \t]*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function extractSpoken(text) {
    // 0) 剥掉行首的【人名】：标记本身
    let t = text.replace(/^\s*【[^】]*】\s*[:：]/, ' ');
    // 1) 去掉全角括号中的中文翻译
    t = t.replace(/（[^（）]*）/g, ' ');
    // 2) 有引号则只取引号内的英文
    const quoted = [];
    const qre = /[“"]([^“”"]+)[”"]/g;
    let qm;
    while ((qm = qre.exec(t)) !== null) quoted.push(qm[1]);
    if (quoted.length > 0) t = quoted.join(' ');
    // 3) 清理动作星号和多余空白
    t = t.replace(/\*[^*\n]*\*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return t;
}

function parseSegments(text) {
    const segs = [];
    for (const line of text.split('\n')) {
        LINE_RE.lastIndex = 0;
        const marks = [];
        let m;
        while ((m = LINE_RE.exec(line)) !== null) {
            marks.push({ name: m[1].trim(), start: m.index, contentStart: LINE_RE.lastIndex });
        }
        if (marks.length === 0) {
            const t = cleanText(line);
            if (t) segs.push({ name: null, text: t });
            continue;
        }
        for (let i = 0; i < marks.length; i++) {
            const end = i + 1 < marks.length ? marks[i + 1].start : line.length;
            const t = cleanText(line.slice(marks[i].contentStart, end));
            if (t) segs.push({ name: marks[i].name, text: t });
        }
    }
    return segs;
}

function voiceFor(name) {
    if (name === null || name === undefined) return settings.narratorVoice || null;
    return settings.voiceMap[name] ?? null;
}

// ==================== 播放队列 ====================

const queue = [];
let currentAudio = null;
let isPlaying = false;
let prefetchPromise = null;
let prefetchFor = null;

function playBlob(blob) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
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
        if (queue.length > 0) {
            const next = queue[0];
            prefetchFor = next;
            prefetchPromise = synth(next.text, next.voice).catch(() => null);
        }
        if (blob) await playBlob(blob);
    } catch (e) {
        console.error('[MultiTTS]', e);
        notify(e.message, 'error', 5000);
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

function playLine(name, spoken) {
    if (!spoken) return;
    const voice = voiceFor(name);
    if (!voice) {
        notify(`角色「${name}」还没绑定音色（插件管理 → Multi-Char TTS）`, 'warning', 3000);
        return;
    }
    backendReady().then(ok => {
        if (!ok) return;
        stopAll();
        queue.push({ name: name, text: spoken, voice: voice });
        if (!isPlaying) pump();
    });
}

// ==================== 行内装饰 ====================

const BLOCK_SEL = 'p, li, div, h1, h2, h3, h4, h5, h6, blockquote, td';

function normalizeIndex(messageIndex) {
    if (typeof messageIndex === 'number') return messageIndex;
    return getContext().chat.length - 1;
}

function decorateMessage(mesIndex) {
    const mesText = document.querySelector(`#chat .mes[mesid="${mesIndex}"] .mes_text`);
    if (!mesText || mesText.querySelector('.mtts-play')) return;
    const blocks = [...mesText.querySelectorAll(BLOCK_SEL)]
        .filter(b => !b.querySelector(BLOCK_SEL));
    for (const block of blocks) decorateBlock(block);
}

function decorateBlock(block) {
    const nodes = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let n;
    while ((n = walker.nextNode()) !== null) {
        nodes.push({ node: n, start: offset });
        offset += n.nodeValue.length;
    }
    if (nodes.length === 0) return;
    const blockText = nodes.map(x => x.node.nodeValue).join('');

    LINE_RE.lastIndex = 0;
    const marks = [];
    let m;
    while ((m = LINE_RE.exec(blockText)) !== null) {
        marks.push({ name: m[1].trim(), start: m.index });
    }
    if (marks.length === 0) return;

    for (let i = marks.length - 1; i >= 0; i--) {
        const end = i + 1 < marks.length ? marks[i + 1].start : blockText.length;
        wrapSegment(nodes, marks[i].start, end, blockText.slice(marks[i].start, end), marks[i].name);
    }
}

function locateNode(nodes, pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].start <= pos && nodes[i].node.parentNode) {
            return { node: nodes[i].node, offset: pos - nodes[i].start };
        }
    }
    return null;
}

function wrapSegment(nodes, start, end, lineText, name) {
    const s = locateNode(nodes, start);
    const e = locateNode(nodes, end);
    if (!s || !e) return;
    const range = document.createRange();
    try {
        range.setStart(s.node, s.offset);
        range.setEnd(e.node, e.offset);
    } catch (err) { return; }

    const span = document.createElement('span');
    span.className = 'mtts-line';
    try {
        range.surroundContents(span);
    } catch (err) {
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
    }

    const spoken = extractSpoken(lineText);
    const btn = document.createElement('span');
    btn.className = 'mtts-play';
    btn.textContent = '🔊';
    btn.title = spoken ? '朗读本句（仅英文）' : '本句没有可朗读的英文';
    if (!spoken) btn.classList.add('mtts-dim');
    else btn.onclick = (ev) => { ev.stopPropagation(); playLine(name, spoken); };
    span.parentNode.insertBefore(btn, span.nextSibling);
}

function decorateAll() {
    const chat = getContext().chat;
    for (let i = 0; i < chat.length; i++) decorateMessage(i);
}

// ==================== 事件 ====================

function hookEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (messageIndex) => {
        const idx = normalizeIndex(messageIndex);
        decorateMessage(idx);
        if (!settings.enabled) return;
        if (!(await backendReady())) return;
        const msg = getContext().chat[idx];
        if (!msg || msg.is_user || msg.is_system) return;

        const segments = parseSegments(msg.mes)
            .map(s => ({ name: s.name, text: extractSpoken(s.text) }))
            .filter(s => s.text.length > 0);
        if (segments.length === 0) return;
        enqueueMessage(segments);
    });

    eventSource.on(event_types.MESSAGE_SWIPED, (i) => decorateMessage(normalizeIndex(i)));
    eventSource.on(event_types.MESSAGE_EDITED, (i) => decorateMessage(normalizeIndex(i)));
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(decorateAll, 300));
    eventSource.on(event_types.GENERATION_STARTED, () => stopAll());
}

// ==================== UI ====================

function notify(msg, type = 'info', timeout = 2500) {
    try { toastr[type](msg, 'MultiTTS', { timeOut: timeout }); }
    catch (e) { console.warn('[MultiTTS]', msg); }
}

function createFloatButton() {
    if (document.getElementById('multi-tts-float')) return;
    const btn = document.createElement('div');
    btn.id = 'multi-tts-float';
    btn.className = 'mtts-float-btn' + (settings.enabled ? ' mtts-on' : '');
    btn.textContent = '🔊 TTS';
    btn.title = '开关自动朗读（播放中点击=立即停止）';
    btn.onclick = () => {
        if (currentAudio || queue.length > 0) { stopAll(); notify('已停止播放', 'info', 1200); return; }
        settings.enabled = !settings.enabled;
        saveSettings();
        btn.classList.toggle('mtts-on', settings.enabled);
        renderSettings();
        notify(settings.enabled ? '自动朗读已开启' : '自动朗读已关闭', 'info', 1200);
    };
    document.body.appendChild(btn);
}

function voiceInputHtml(selected) {
    if (settings.provider === 'fish') {
        return `<input type="text" class="mtts-voice mtts-fish-voice" placeholder="Fish 音色ID（广场页面复制）" value="${escapeHtml(selected)}">`;
    }
    const opts = edgeVoices.map(v =>
        `<option value="${v.name}" ${v.name === selected ? 'selected' : ''}>${v.name}</option>`).join('');
    return `<select class="mtts-voice mtts-edge-voice">${opts}</select>`;
}

function rowHtml(name, voice) {
    return `<div class="mtts-row mtts-vrow">
        <input type="text" class="mtts-name" placeholder="故事内角色名" value="${escapeHtml(name)}">
        ${voiceInputHtml(voice)}
        <button class="mtts-ghost mtts-preview">🔊</button>
        <button class="mtts-del">✕</button>
    </div>`;
}

function bindRowEvents(root) {
    root.querySelectorAll('.mtts-vrow').forEach(row => {
        if (row.dataset.bound) return;
        row.dataset.bound = '1';
        row.querySelector('.mtts-preview').onclick = () => {
            const v = row.querySelector('.mtts-voice').value.trim();
            if (!v) { notify('先填音色', 'warning', 1200); return; }
            preview(v);
        };
        row.querySelector('.mtts-del').onclick = () => row.remove();
    });
}

async function preview(voice) {
    if (!(await backendReady())) return;
    try {
        if (playingPreview) { playingPreview.pause(); playingPreview = null; }
        const blob = await synth(sampleText, voice);
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
        playingPreview = audio;
        audio.src = url;
        audio.onended = () => { URL.revokeObjectURL(url); if (playingPreview === audio) playingPreview = null; };
        audio.play().catch(() => {});
    } catch (e) {
        notify('试听失败：' + e.message, 'error', 5000);
    }
}
let playingPreview = null;

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function renderSettings() {
    const root = document.getElementById('mtts-settings-root');
    if (!root) return;

    const isFish = settings.provider === 'fish';
    const rows = Object.entries(settings.voiceMap)
        .map(([name, voice]) => rowHtml(name, voice)).join('');

    root.innerHTML = `
        <div class="mtts-status" id="mtts-status">检测后端中…</div>
        <label class="mtts-field">朗读引擎
            <select id="mtts-provider">
                <option value="fish" ${isFish ? 'selected' : ''}>Fish Audio（高仿真，免费档）</option>
                <option value="edge" ${!isFish ? 'selected' : ''}>Edge TTS（免费稳定，质感一般）</option>
            </select>
        </label>
        <div id="mtts-fish-config" style="${isFish ? '' : 'display:none'}">
            <label class="mtts-field">Fish API Key
                <input type="password" id="mtts-fish-key" value="${escapeHtml(settings.fishKey)}" placeholder="fish.audio 开发者页面创建">
            </label>
            <label class="mtts-field">Fish 模型
                <input type="text" id="mtts-fish-model" value="${escapeHtml(settings.fishModel)}">
            </label>
            <div class="mtts-hint">音色ID：fish.audio「发现」广场里打开任意声音，页面上的 model id 即 reference_id，复制粘贴到下方。</div>
        </div>
        <div id="mtts-edge-config" style="${isFish ? 'display:none' : ''}">
            <label class="mtts-field">Edge 语速 <span id="mtts-rate-out">${settings.rate}</span>
                <input type="range" id="mtts-rate" min="-50" max="50" step="5" value="${settings.rate}">
            </label>
        </div>
        <label class="mtts-field" id="mtts-speed-wrap" style="${isFish ? '' : 'display:none'}">Fish 语速 <span id="mtts-speed-out">${settings.speed}</span>
            <input type="range" id="mtts-speed" min="0.5" max="1.5" step="0.05" value="${settings.speed}">
        </label>
        <hr>
        <div class="mtts-hint">角色音色绑定（角色名 = 世界书格式里【】中的名字，不是卡名）。对话行尾的 🔊 随时可点。</div>
        <div id="mtts-rows">${rows}</div>
        <button class="mtts-ghost" id="mtts-add">＋ 添加角色</button>
        <div class="mtts-row" style="margin-top:8px">
            <span style="flex:1">旁白（未匹配到人名的文本）</span>
            <span id="mtts-narrator-wrap">${voiceInputHtml(settings.narratorVoice)}</span>
            <button class="mtts-ghost mtts-preview-n">🔊</button>
        </div>
        <label class="mtts-field"><input type="checkbox" id="mtts-enabled" ${settings.enabled ? 'checked' : ''}> 新消息自动朗读（默认关）</label>
        <button id="mtts-save">保存设置</button>
    `;

    bindRowEvents(root);
    root.querySelector('.mtts-preview-n').onclick = () => {
        const v = root.querySelector('#mtts-narrator-wrap .mtts-voice').value.trim();
        if (!v) { notify('先选旁白音色', 'warning', 1200); return; }
        preview(v);
    };

    root.querySelector('#mtts-provider').onchange = async (e) => {
        settings.provider = e.target.value;
        if (settings.provider === 'edge' && edgeVoices.length === 0) {
            root.querySelector('#mtts-status').textContent = '正在获取 Edge 音色列表…';
            edgeVoices = await fetchEdgeVoices();
        }
        saveSettings();
        renderSettings();
    };
    root.querySelector('#mtts-rate').oninput = (e) => {
        root.querySelector('#mtts-rate-out').textContent = e.target.value;
    };
    root.querySelector('#mtts-speed').oninput = (e) => {
        root.querySelector('#mtts-speed-out').textContent = e.target.value;
    };
    root.querySelector('#mtts-add').onclick = async () => {
        if (settings.provider === 'edge' && edgeVoices.length === 0) {
            edgeVoices = await fetchEdgeVoices();
            if (edgeVoices.length === 0) { notify('Edge 音色列表为空，检查后端', 'warning'); return; }
        }
        root.querySelector('#mtts-rows').insertAdjacentHTML('beforeend', rowHtml('', ''));
        bindRowEvents(root.querySelector('#mtts-rows'));
    };
    root.querySelector('#mtts-save').onclick = () => {
        const voiceMap = {};
        root.querySelectorAll('.mtts-vrow').forEach(row => {
            const name = row.querySelector('.mtts-name').value.trim();
            const voice = row.querySelector('.mtts-voice').value.trim();
            if (name) voiceMap[name] = voice;
        });
        settings.voiceMap = voiceMap;
        settings.narratorVoice = root.querySelector('#mtts-narrator-wrap .mtts-voice').value.trim();
        settings.fishKey = root.querySelector('#mtts-fish-key')?.value.trim() ?? settings.fishKey;
        settings.fishModel = root.querySelector('#mtts-fish-model')?.value.trim() || 's2.1-pro-free';
        settings.rate = Number(root.querySelector('#mtts-rate')?.value ?? settings.rate);
        settings.speed = Number(root.querySelector('#mtts-speed')?.value ?? settings.speed);
        settings.enabled = root.querySelector('#mtts-enabled').checked;
        saveSettings();
        document.getElementById('multi-tts-float')?.classList.toggle('mtts-on', settings.enabled);
        notify('已保存', 'success', 1500);
    };

    updateStatus(root.querySelector('#mtts-status'));
}

async function updateStatus(el) {
    if (!el) return;
    if (settings.provider === 'fish') {
        el.textContent = settings.fishKey
            ? `✅ Fish Audio 就绪（模型 ${settings.fishModel}；走酒馆 /proxy 转发）`
            : '⚠️ 请先填写 Fish API Key';
    } else {
        const ok = await detectEdgeBackend();
        el.textContent = ok
            ? `✅ Edge TTS 后端正常（${edgeBackend}），音色 ${(await fetchEdgeVoices()).length} 个`
            : '⚠️ Edge TTS 后端不可用：需安装 EdgeTTS 插件或 Extras 的 edge-tts 模块';
    }
}

function injectSettingsUI() {
    const container = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings');
    if (!container || document.getElementById('mtts-settings-root')) return;
    const wrap = document.createElement('div');
    wrap.id = 'mtts-settings-root';
    wrap.className = 'mtts-settings';
    container.appendChild(wrap);
    renderSettings();
}

// ==================== 启动 ====================

export function init() {
    try {
        loadSettings();
        console.info(`[MultiTTS] v${VERSION} initializing, provider=${settings.provider}`);
        hookEvents();
        createFloatButton();
        injectSettingsUI();
        setTimeout(decorateAll, 300);
        setTimeout(decorateAll, 1500);
        notify(`Multi-Char TTS v${VERSION} 已加载（右下角 🔊，设置在插件管理里）`, 'success', 4000);
        console.info(`[MultiTTS] v${VERSION} loaded OK`);
    } catch (e) {
        console.error('[MultiTTS] 初始化失败:', e);
        try {
            toastr.error(`Multi-Char TTS 初始化失败：${e.message}（详见 F12 Console）`, 'MultiTTS', { timeOut: 12000 });
        } catch (_) { /* toastr 不可用时只能看控制台 */ }
    }
}
