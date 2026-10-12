/**
 * menu.js · 魔法棒菜单项 + 生词本弹窗（复习/词表/数据 三标签）
 */

import * as storage from './storage.js';
import * as srs from './srs.js';
import { renderReviewTab } from './review.js';
import { renderWordsTab } from './words.js';
import { renderDataTab } from './dataio.js';

let modal = null;
let activeTab = 'review';
const TAB_RENDERERS = { review: renderReviewTab, words: renderWordsTab, data: renderDataTab };

function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'vocab-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
        <div class="vocab-backdrop"></div>
        <div class="vocab-window">
            <div class="vocab-header">
                <span>📒 生词本</span>
                <span id="vocab-due-badge" class="vocab-badge"></span>
                <button id="vocab-close" title="关闭">✕</button>
            </div>
            <div class="vocab-tabs">
                <button data-tab="review" class="vocab-tab">复习</button>
                <button data-tab="words" class="vocab-tab">词表</button>
                <button data-tab="data" class="vocab-tab">数据</button>
            </div>
            <div id="vocab-tab-content" class="vocab-tab-content"></div>
        </div>`;
    document.body.appendChild(modal);

    modal.querySelector('.vocab-backdrop').onclick = closeModal;
    modal.querySelector('#vocab-close').onclick = closeModal;
    modal.querySelectorAll('.vocab-tab').forEach(btn => {
        btn.onclick = () => switchTab(btn.dataset.tab);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display !== 'none') closeModal();
    });
    return modal;
}

async function updateBadge() {
    try {
        await storage.load();
        const n = storage.list().filter(r => srs.isDue(r.srs)).length;
        const badge = modal?.querySelector('#vocab-due-badge');
        if (badge) badge.textContent = n > 0 ? `今日到期 ${n}` : '';
    } catch (e) { /* 文件还没创建时静默 */ }
}

async function switchTab(tab) {
    activeTab = tab;
    const m = ensureModal();
    m.querySelectorAll('.vocab-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const content = m.querySelector('#vocab-tab-content');
    content.innerHTML = '<div class="vocab-empty">加载中…</div>';
    try {
        await TAB_RENDERERS[tab](content);
    } catch (e) {
        console.error('[Vocab]', e);
        content.innerHTML = `<div class="vocab-empty">加载失败：${e.message}</div>`;
    }
    updateBadge();
}

export function openModal(tab) {
    const m = ensureModal();
    m.style.display = 'flex';
    switchTab(tab || activeTab);
}

export function closeModal() {
    if (modal) modal.style.display = 'none';
}

export function initMenu() {
    // 魔法棒菜单项（#options > .options-content 内追加 <a>）
    if (!document.getElementById('option_vocab_notebook')) {
        const item = document.createElement('a');
        item.id = 'option_vocab_notebook';
        item.innerHTML = '<i class="fa-lg fa-solid fa-book"></i><span>生词本</span>';
        const host = document.querySelector('#options .options-content');
        if (host) host.appendChild(item);
    }
    document.getElementById('option_vocab_notebook')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('options')?.style.setProperty('display', 'none');
        openModal('review');
    });

    // 外部变动（选词入库、数据页导入）后刷新徽标
    document.addEventListener('vocab-changed', updateBadge);

    // 首次后台加载 + 徽标
    updateBadge();
}
