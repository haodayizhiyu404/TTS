/**
 * Multi-Char TTS · 多角色分音色朗读（独立扩展版）
 * ------------------------------------------------------------
 * 存储设计（两层）：
 * - 全局层（extension_settings，本机）：引擎、Fish API key、模型、自动朗读开关
 * - 卡片层（角色卡 data.extensions['multi-char-tts']，随卡导出）：
 *   该卡的多角色音色表 {角色名: 音色ID}、旁白音色、语速
 * ------------------------------------------------------------
 * 引擎：
 * - Fish Audio：POST /proxy/https://api.fish.audio/v1/tts（需 config.yaml
 *   的 enableCorsProxy: true），免费模型 s2.1-pro-free
 * - Edge TTS：/api/edge-tts/*（需 EdgeTTS 服务端插件或 Extras）
 */

import { extension_settings, getContext, writeExtensionField } from '../../../extensions.js';
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';

const EXTENSION_NAME = 'multi-char-tts';
const VERSION = '2.3.4';

const DEFAULT_GLOBAL = {
    provider: 'fish',        // 'fish' | 'edge'
    fishKey: '',
    fishModel: 's2.1-pro-free',
    rate: 0,                 // Edge 语速 -50~+50
    enabled: false,          // 自动朗读
};

const DEFAULT_CARD = {
    voiceMap: {},            // { 故事内角色名: 音色ID }
    speed: 1,                // Fish 语速 0.5~1.5
};

let global = {};
let card = null;             // 当前卡配置（null = 未打开卡/群聊）
let currentCharIndex = -1;
let edgeVoices = [];
let edgeBackend = null;
const sampleText = 'Hey! This is a voice preview. Nice to meet you!';

// ==================== 全局设置 ====================

function loadGlobal() {
    extension_settings[EXTENSION_NAME] = Object.assign({}, DEFAULT_GLOBAL, extension_settings[EXTENSION_NAME]);
    global = extension_settings[EXTENSION_NAME];
}

function saveGlobal() {
    saveSettingsDebounced();
}

// ==================== 卡片设置（data.extensions，随卡导出） ====================

function refreshCardContext() {
    const ctx = getContext();
    // context.characterId 即角色在 characters 数组中的下标（官方字段，不是 avatar）
    const idx = Number(ctx.characterId);
    currentCharIndex = Number.isInteger(idx) && idx >= 0 ? idx : -1;
    if (currentCharIndex < 0) {
        card = null;
        return;
    }
    const raw = ctx.characters[currentCharIndex]?.data?.extensions?.[EXTENSION_NAME];
    card = Object.assign({}, DEFAULT_CARD, raw ? JSON.parse(JSON.stringify(raw)) : {});
}

async function saveCard() {
    if (currentCharIndex < 0 || !card) return;
    await writeExtensionField(currentCharIndex, EXTENSION_NAME, JSON.parse(JSON.stringify(card)));
}

function cardName() {
    if (currentCharIndex < 0) return null;
    return getContext().characters[currentCharIndex]?.name ?? null;
}

// ==================== 后端：Fish / Edge ====================

async function synthFish(text, voice) {
    const r = await fetch('/proxy/https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${global.fishKey}`,
            'model': global.fishModel || 's2.1-pro-free',
        },
        body: JSON.stringify({
            text: text,
            reference_id: voice,
            format: 'mp3',
            prosody: { speed: Number(card?.speed) || 1 },
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
        body: JSON.stringify({ text: text, voice: voice, rate: Number(global.rate) }),
    });
    if (!r.ok) throw new Error(`Edge TTS HTTP ${r.status}`);
    return await r.blob();
}

async function synth(text, voice) {
    if (global.provider === 'fish') return await synthFish(text, voice);
    return await synthEdge(text, voice);
}

async function backendReady() {
    if (global.provider === 'fish') {
        if (!global.fishKey) {
            notify('还没填 Fish API key（展开 Multi-Char TTS 面板）', 'warning', 4000);
            return false;
        }
        return true;
    }
    if (!(await detectEdgeBackend())) {
        notify('Edge TTS 后端不可用：需安装 EdgeTTS 插件或 Extras 的 edge-tts 模块', 'warning', 5000);
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
    let t = text.replace(/^\s*【[^】]*】\s*[:：]/, ' ');
    t = t.replace(/（[^（）]*）/g, ' ');
    const quoted = [];
    const qre = /[“"]([^“”"]+)[”"]/g;
    let qm;
    while ((qm = qre.exec(t)) !== null) quoted.push(qm[1]);
    if (quoted.length > 0) t = quoted.join(' ');
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
    if (!card) return null;
    if (name === null || name === undefined) return null; // 不朗读旁白/未匹配文本
    return card.voiceMap[name] ?? null;
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
        notify(`角色「${name}」还没绑定音色（Multi-Char TTS 面板）`, 'warning', 3000);
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
        if (!global.enabled) return;
        if (!(await backendReady())) return;
        refreshCardContext();
        const msg = getContext().chat[idx];
        if (!msg || msg.is_user || msg.is_system) return;

        const segments = parseSegments(msg.mes)
            .map(s => ({ name: s.name, text: extractSpoken(s.text) }))
            .filter(s => s.text.length > 0);
        if (segments.length === 0) return;
        enqueueMessage(segments);
    });

    eventSource.on(event_types.MESSAGE_SWIPED, (i) => setTimeout(() => decorateMessage(normalizeIndex(i)), 300));
    // 编辑后酒馆会重渲染 DOM，事件触发时新 DOM 未必就绪，延迟装饰
    eventSource.on(event_types.MESSAGE_EDITED, (i) => setTimeout(() => decorateMessage(normalizeIndex(i)), 300));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        stopAll();
        refreshCardContext();
        setTimeout(decorateAll, 300);
        renderSettings();
    });
    eventSource.on(event_types.GENERATION_STARTED, () => stopAll());
}

// ==================== UI ====================

function notify(msg, type = 'info', timeout = 2500) {
    try { toastr[type](msg, 'MultiTTS', { timeOut: timeout }); }
    catch (e) { console.warn('[MultiTTS]', msg); }
}

function voiceInputHtml(selected) {
    if (global.provider === 'fish') {
        return `<input type="text" class="mtts-voice mtts-fish-voice" placeholder="Fish 音色ID（广场页面复制）" value="${escapeHtml(selected)}">`;
    }
    const opts = edgeVoices.map(v =>
        `<option value="${v.name}" ${v.name === selected ? 'selected' : ''}>${v.name}</option>`).join('');
    return `<select class="mtts-voice mtts-edge-voice">${opts}</select>`;
}

// 编辑态行：✓ 完成（即时写卡），✕ 取消（恢复原值/移除草稿）
function editRowHtml(name, voice, orig) {
    const origAttrs = orig ? `data-orig-name="${escapeHtml(orig.name)}" data-orig-voice="${escapeHtml(orig.voice)}"` : '';
    return `<div class="mtts-row mtts-vrow" ${origAttrs}>
        <input type="text" class="mtts-name" placeholder="故事内角色名" value="${escapeHtml(name)}">
        ${voiceInputHtml(voice)}
        <button class="mtts-ghost mtts-preview" title="试听">🔊</button>
        <button class="mtts-ok" title="完成">✓</button>
        <button class="mtts-del" title="取消">✕</button>
    </div>`;
}

// 显示态行：已保存的绑定，只读；✎ 进入编辑，🗑 删除（确认后立即生效）
function viewRowHtml(name, voice) {
    const short = voice.length > 28 ? voice.slice(0, 28) + '…' : voice;
    return `<div class="mtts-row mtts-vrow-view" data-name="${escapeHtml(name)}" data-voice="${escapeHtml(voice)}">
        <span class="mtts-chip mtts-chip-name">${escapeHtml(name)}</span>
        <span class="mtts-chip mtts-chip-voice" title="${escapeHtml(voice)}">${escapeHtml(short)}</span>
        <button class="mtts-ghost mtts-preview" title="试听">🔊</button>
        <button class="mtts-ghost mtts-edit" title="编辑">✎</button>
        <button class="mtts-del" title="删除绑定">🗑</button>
    </div>`;
}

function commitEditRow(row) {
    const n = row.querySelector('.mtts-name').value.trim();
    const v = row.querySelector('.mtts-voice').value.trim();
    if (!n) { notify('角色名不能为空', 'warning', 2000); return; }
    if (!card) return;
    card.voiceMap[n] = v;
    saveCard().then(() => {
        const frag = document.createElement('div');
        frag.innerHTML = viewRowHtml(n, v);
        const view = frag.firstElementChild;
        row.replaceWith(view);
        bindRowEvents(view.parentElement);
        notify('已写入角色卡', 'success', 1200);
    });
}

function cancelEditRow(row) {
    const origName = row.dataset.origName;
    if (origName !== undefined) {
        const frag = document.createElement('div');
        frag.innerHTML = viewRowHtml(origName, row.dataset.origVoice || '');
        const view = frag.firstElementChild;
        row.replaceWith(view);
        bindRowEvents(view.parentElement);
    } else {
        row.remove(); // 草稿行，取消即丢弃
    }
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
        row.querySelector('.mtts-ok').onclick = () => commitEditRow(row);
        row.querySelector('.mtts-del').onclick = () => cancelEditRow(row); // 编辑态的 ✕ = 取消
    });
    root.querySelectorAll('.mtts-vrow-view').forEach(row => {
        if (row.dataset.bound) return;
        row.dataset.bound = '1';
        row.querySelector('.mtts-preview').onclick = () => preview(row.dataset.voice);
        row.querySelector('.mtts-edit').onclick = () => {
            const frag = document.createElement('div');
            frag.innerHTML = editRowHtml(row.dataset.name, row.dataset.voice,
                { name: row.dataset.name, voice: row.dataset.voice });
            const editRow = frag.firstElementChild;
            row.replaceWith(editRow);
            bindRowEvents(editRow.parentElement || root);
        };
        row.querySelector('.mtts-del').onclick = () => { // 显示态的 🗑 = 删除，确认后立即生效
            const n = row.dataset.name;
            if (!confirm(`删除角色「${n}」的音色绑定？`)) return;
            if (card) delete card.voiceMap[n];
            saveCard().then(() => {
                row.remove();
                notify('已删除', 'success', 1200);
            });
        };
    });
}

let playingPreview = null;
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

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function renderSettings() {
    const root = document.getElementById('mtts-settings-root');
    if (!root) return;
    const isFish = global.provider === 'fish';
    const name = cardName();
    const rows = card ? Object.entries(card.voiceMap)
        .map(([n, v]) => viewRowHtml(n, v)).join('') : '';

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
                <input type="password" id="mtts-fish-key" value="${escapeHtml(global.fishKey)}" placeholder="fish.audio 开发者页面创建">
            </label>
            <label class="mtts-field">Fish 模型
                <input type="text" id="mtts-fish-model" value="${escapeHtml(global.fishModel)}">
            </label>
        </div>
        <div id="mtts-edge-config" style="${isFish ? 'display:none' : ''}">
            <label class="mtts-field">Edge 语速 <span id="mtts-rate-out">${global.rate}</span>
                <input type="range" id="mtts-rate" min="-50" max="50" step="5" value="${global.rate}">
            </label>
        </div>
        <label class="mtts-field"><input type="checkbox" id="mtts-enabled" ${global.enabled ? 'checked' : ''}> 新消息自动朗读（默认关）</label>

        <hr>
        ${card ? `
        <div class="mtts-hint">当前角色卡：<b>${escapeHtml(name)}</b>（音色表存在卡上，随卡导出）</div>
        <div class="mtts-hint">角色名 = 世界书格式里【】中的名字，不是卡名。对话行尾的 🔊 随时可点。</div>
        <div id="mtts-rows">${rows}</div>
        <button class="mtts-ghost" id="mtts-add">＋ 添加角色</button>
        <div class="mtts-hint">✓ 完成即写入角色卡；✕ 取消。所有改动自动保存，无需手动提交。</div>
        <label class="mtts-field" style="${isFish ? '' : 'display:none'}; margin-top:8px">Fish 语速 <span id="mtts-speed-out">${card.speed}</span>
            <input type="range" id="mtts-speed" min="0.5" max="1.5" step="0.05" value="${card.speed}">
        </label>
        ` : `
        <div class="mtts-hint">⚠️ 请先打开一张角色卡（群聊暂不支持按卡配置音色）</div>
        `}
    `;

    if (!card) {
        updateStatus(root.querySelector('#mtts-status'));
        return;
    }

    bindRowEvents(root);
    root.querySelector('#mtts-provider').onchange = async (e) => {
        global.provider = e.target.value;
        if (global.provider === 'edge' && edgeVoices.length === 0) {
            root.querySelector('#mtts-status').textContent = '正在获取 Edge 音色列表…';
            edgeVoices = await fetchEdgeVoices();
        }
        saveGlobal();
        renderSettings();
    };
    const rateEl = root.querySelector('#mtts-rate');
    if (rateEl) rateEl.oninput = (e) => { root.querySelector('#mtts-rate-out').textContent = e.target.value; };
    const speedEl = root.querySelector('#mtts-speed');
    if (speedEl) speedEl.oninput = (e) => { root.querySelector('#mtts-speed-out').textContent = e.target.value; };
    root.querySelector('#mtts-add').onclick = async () => {
        if (global.provider === 'edge' && edgeVoices.length === 0) {
            edgeVoices = await fetchEdgeVoices();
            if (edgeVoices.length === 0) { notify('Edge 音色列表为空，检查后端', 'warning'); return; }
        }
        root.querySelector('#mtts-rows').insertAdjacentHTML('beforeend', editRowHtml('', ''));
        bindRowEvents(root.querySelector('#mtts-rows'));
    };
    // 全局项：一变即存
    root.querySelector('#mtts-fish-key')?.addEventListener('change', (e) => {
        global.fishKey = e.target.value.trim();
        saveGlobal();
    });
    root.querySelector('#mtts-fish-model')?.addEventListener('change', (e) => {
        global.fishModel = e.target.value.trim() || 's2.1-pro-free';
        saveGlobal();
    });
    root.querySelector('#mtts-enabled')?.addEventListener('change', (e) => {
        global.enabled = e.target.checked;
        saveGlobal();
        notify(global.enabled ? '自动朗读已开启' : '自动朗读已关闭', 'info', 1200);
    });
    if (rateEl) rateEl.addEventListener('change', (e) => {
        global.rate = Number(e.target.value);
        saveGlobal();
    });
    if (speedEl) speedEl.addEventListener('change', (e) => {
        if (!card) return;
        card.speed = Number(e.target.value);
        saveCard();
    });

    updateStatus(root.querySelector('#mtts-status'));
}

async function updateStatus(el) {
    if (!el) return;
    if (global.provider === 'fish') {
        el.textContent = global.fishKey
            ? `✅ Fish Audio 就绪（模型 ${global.fishModel}；走酒馆 /proxy 转发）`
            : '⚠️ 请先填写 Fish API Key';
    } else {
        const ok = await detectEdgeBackend();
        el.textContent = ok
            ? `✅ Edge TTS 后端正常（${edgeBackend}），音色 ${(await fetchEdgeVoices()).length} 个`
            : '⚠️ Edge TTS 后端不可用：需安装 EdgeTTS 插件或 Extras 的 edge-tts 模块';
    }
}

// 折叠面板：酒馆标准 inline-drawer 结构
function injectSettingsUI() {
    const container = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings');
    if (!container || document.getElementById('mtts-drawer')) return;
    const wrap = document.createElement('div');
    wrap.id = 'mtts-drawer';
    wrap.className = 'inline-drawer';
    wrap.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Multi-Char TTS（多角色分音色朗读）</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="mtts-settings-root" class="mtts-settings"></div>
        </div>`;
    container.appendChild(wrap);
    renderSettings();
}

// ==================== 启动 ====================

export function init() {
    try {
        loadGlobal();
        refreshCardContext();
        console.info(`[MultiTTS] v${VERSION} initializing, provider=${global.provider}, card=${cardName() ?? 'none'}`);
        hookEvents();
        injectSettingsUI();
        setTimeout(decorateAll, 300);
        setTimeout(decorateAll, 1500);
        // 页面初始化早期 characterId 可能未就绪，延迟复查一次卡片上下文
        setTimeout(() => { refreshCardContext(); renderSettings(); }, 1200);
        notify(`Multi-Char TTS v${VERSION} 已加载`, 'success', 3000);
        console.info(`[MultiTTS] v${VERSION} loaded OK`);
    } catch (e) {
        console.error('[MultiTTS] 初始化失败:', e);
        try {
            toastr.error(`Multi-Char TTS 初始化失败：${e.message}（详见 F12 Console）`, 'MultiTTS', { timeOut: 12000 });
        } catch (_) { /* toastr 不可用时只能看控制台 */ }
    }
}
