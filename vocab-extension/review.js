/**
 * review.js · 复习翻卡页（弹窗内「复习」标签）
 */

import * as storage from './storage.js';
import * as srs from './srs.js';

const QUALITY = { again: 0, hard: 3, good: 5 };
let deck = [];        // 今日到期队列
let flipped = false;

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function senseHtml(s) {
    const badge = s.in_context ? '<span class="vocab-ctx-badge">本剧情义项</span>' : '';
    const cols = (s.collocations || []).length
        ? `<div class="vocab-colloc">搭配：${s.collocations.map(esc).join('、')}</div>` : '';
    const note = s.note ? `<div class="vocab-note">💡 ${esc(s.note)}</div>` : '';
    return `<div class="vocab-sense ${s.in_context ? 'ctx' : ''}">
        <div class="vocab-sense-head"><b>${esc(s.pos)}</b> ${esc(s.meaning)} ${badge}</div>
        <div class="vocab-example">${esc(s.example)}</div>
        ${cols}${note}
    </div>`;
}

function render(container) {
    if (deck.length === 0) {
        container.innerHTML = `<div class="vocab-empty">🎉 今日到期已全部清完</div>`;
        return;
    }
    const rec = deck[0];
    if (!flipped) {
        container.innerHTML = `
            <div class="vocab-card front" id="vocab-card">
                <div class="vocab-word">${esc(rec.word)}</div>
                <div class="vocab-flip-hint">点击翻面看解析</div>
            </div>
            <div class="vocab-progress">剩余 ${deck.length} 张</div>`;
        container.querySelector('#vocab-card').onclick = () => { flipped = true; render(container); };
    } else {
        const sorted = [...rec.senses].sort((a, b) => (b.in_context ? 1 : 0) - (a.in_context ? 1 : 0));
        container.innerHTML = `
            <div class="vocab-card back">
                <div class="vocab-word small">${esc(rec.word)}</div>
                ${sorted.map(senseHtml).join('')}
                <div class="vocab-source">出处：${esc(rec.source?.card || '未知')} ｜ ${esc((rec.source?.line || '').slice(0, 80))}</div>
            </div>
            <div class="vocab-grade-row">
                <button data-q="${QUALITY.again}" class="vocab-grade again">不会</button>
                <button data-q="${QUALITY.hard}" class="vocab-grade hard">模糊</button>
                <button data-q="${QUALITY.good}" class="vocab-grade good">认识</button>
            </div>
            <div class="vocab-progress">剩余 ${deck.length} 张</div>`;
        container.querySelectorAll('.vocab-grade').forEach(btn => {
            btn.onclick = async () => {
                const q = Number(btn.dataset.q);
                await storage.update(rec.word, (r) => { r.srs = srs.grade(r.srs, q); });
                deck.shift();
                flipped = false;
                render(container);
            };
        });
    }
}

export async function renderReviewTab(container) {
    flipped = false;
    await storage.load();
    const today = srs.todayStr();
    deck = storage.list().filter(r => srs.isDue(r.srs, today))
        .sort((a, b) => (a.srs.due || '').localeCompare(b.srs.due || ''));
    // 新词（interval=0 从未复习过）插到队尾今天顺带认识一下？不，新词按到期日正常排序即可
    render(container);
}
