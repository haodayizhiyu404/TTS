/**
 * index.js · 生词本扩展入口
 * 装配：魔法棒菜单 + 弹窗（menu.js）、聊天选词（selection.js）、落盘兜底（storage.flushNow）
 */

import { initMenu } from './menu.js';
import { initSelection } from './selection.js';
import * as storage from './storage.js';

export function init() {
    try {
        initMenu();
        initSelection();
        // 切页/关页前把未落盘的改动写出去
        window.addEventListener('pagehide', () => { storage.flushNow(); });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') storage.flushNow();
        });
        console.info('[Vocab] 生词本扩展已加载');
    } catch (e) {
        console.error('[Vocab] 初始化失败:', e);
        try {
            toastr.error(`生词本初始化失败：${e.message}`, '生词本', { timeOut: 10000 });
        } catch (_) { /* toastr 不可用时只能看控制台 */ }
    }
}
