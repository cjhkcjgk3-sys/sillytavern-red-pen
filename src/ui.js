import { material } from './core.js';

export function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
}
export function button(text, action) {
    const el = node('button', text, 'menu_button'); el.type = 'button';
    el.addEventListener('click', () => Promise.resolve().then(action).catch(e => alert(e.message)));
    return el;
}
export async function copy(text) {
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP/permissions fallback */ }
    }
    const el = node('textarea'); el.value = text; el.className = 'rp-copy'; document.body.append(el); el.select();
    const done = document.execCommand('copy'); el.remove();
    if (!done) throw new Error('复制失败，请在展开的原文中长按复制');
}
export class UI {
    constructor(app) {
        this.app = app; this.selected = new Set(); this.query = ''; this.rows = [];
        this.bar = node('div', null, 'rp-bar'); this.bar.id = 'red-pen-bar';
        this.toggle = button('红笔：关闭', () => app.setEnabled(!app.enabled));
        this.toggle.setAttribute('aria-pressed', 'false');
        this.libraryButton = button('标记库 0', () => this.open());
        this.bar.append(this.toggle, this.libraryButton); document.body.append(this.bar);
        this.action = node('div', null, 'rp-action'); this.action.hidden = true;
        this.action.setAttribute('role', 'toolbar'); this.action.setAttribute('aria-label', '文字选区操作');
        this.action.addEventListener('pointerdown', e => e.preventDefault());
        document.body.append(this.action);
        this.toast = node('div', null, 'rp-toast'); this.toast.hidden = true; this.toast.setAttribute('role', 'status'); document.body.append(this.toast);
        this.dialog = node('dialog', null, 'rp-library'); this.dialog.setAttribute('aria-label', '当前聊天标记库');
        const header = node('header'); header.append(node('strong', '标记库'), button('关闭', () => this.dialog.close()));
        this.state = node('p', null, 'rp-state');
        this.search = node('input'); this.search.type = 'search'; this.search.placeholder = '搜索摘录原文'; this.search.setAttribute('aria-label', '搜索摘录原文');
        this.search.addEventListener('input', () => { this.query = this.search.value; this.selected.clear(); this.renderRows(); });
        const management = node('div', null, 'rp-management');
        this.selectAll = node('input'); this.selectAll.type = 'checkbox';
        const selectLabel = node('label', ' 全选搜索结果'); selectLabel.prepend(this.selectAll);
        this.selectAll.addEventListener('change', () => { this.selected = new Set(this.selectAll.checked ? this.filtered().map(r => r.id) : []); this.renderRows(); });
        this.copySelected = button('复制已选 0', async () => { const rows = this.app.library.records.filter(r => this.selected.has(r.id)); await copy(rows.map(r => r.text).join('\n\n')); this.say(`已复制 ${rows.length} 条原文`); });
        this.cancelSelected = button('取消已选 0', async () => {
            const ids = [...this.selected];
            if (ids.length && confirm(`取消当前聊天中选中的 ${ids.length} 条标记？可在短暂提示中撤销。`)) { await app.remove(ids); this.selected.clear(); }
        });
        management.append(selectLabel, this.copySelected, this.cancelSelected);
        const more = node('details', null, 'rp-more'); more.append(node('summary', '更多'));
        const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
        file.addEventListener('change', async () => {
            const f = file.files[0]; file.value = ''; if (!f) return;
            try {
                if (f.size > 20 * 1024 * 1024) throw new Error('备份超过 20 MiB，请使用较小的备份文件');
                await app.importBackup(JSON.parse(await f.text()));
            } catch (e) { this.say('恢复失败：' + e.message); }
        });
        more.append(button('导出备份', () => app.download()), button('恢复备份到当前聊天', () => file.click()), button('查看本次附加内容', () => this.preview()), file);
        this.list = node('div', null, 'rp-list'); this.list.setAttribute('role', 'list');
        this.dialog.append(header, this.state, this.search, management, more, this.list);
        this.dialog.addEventListener('click', e => { if (e.target === this.dialog) { const r = this.dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.dialog.close(); } });
        document.body.append(this.dialog);
        this.inspect = node('dialog', null, 'rp-library rp-inspect'); this.inspect.setAttribute('aria-label', '附加内容核对'); document.body.append(this.inspect);
    }
    filtered() { return (this.app.library?.records ?? []).filter(r => r.text.includes(this.query)); }
    say(message, undo) {
        clearTimeout(this.toastTimer); this.toast.replaceChildren(node('span', message)); this.toast.hidden = false;
        if (undo) this.toast.append(button('撤销', async () => { await undo(); this.toast.hidden = true; }));
        this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, undo ? 10000 : 6500);
    }
    update() {
        const total = this.app.library?.records.length ?? 0;
        this.toggle.textContent = `红笔：${this.app.enabled ? '开启' : '关闭'}`;
        this.toggle.setAttribute('aria-pressed', String(this.app.enabled));
        this.libraryButton.textContent = `标记库 ${total}`;
        if (this.dialog.open) this.renderRows();
    }
    async open() {
        await this.app.refresh();
        if (!this.app.library) { this.say('请先进入一段已保存的聊天'); return; }
        this.query = ''; this.search.value = ''; this.selected.clear(); this.renderRows();
        if (!this.dialog.open) this.dialog.showModal();
    }
    renderRows() {
        const lib = this.app.library;
        if (!lib) { this.list.replaceChildren(node('p', '当前没有可用聊天')); return; }
        const rows = this.filtered();
        const ids = new Set(rows.map(r => r.id));
        this.selected = new Set([...this.selected].filter(id => ids.has(id)));
        const chars = lib.records.reduce((n, r) => n + [...r.text].length, 0);
        this.state.textContent = `${lib.label} · ${lib.records.length} 条 · ${chars} 字\n${this.app.enabled ? '全部有效标记参与后续聊天请求' : '标记已暂停，内容仍已保存'}`;
        this.selectAll.checked = rows.length > 0 && rows.every(r => this.selected.has(r.id));
        this.selectAll.indeterminate = this.selected.size > 0 && !this.selectAll.checked;
        this.selectAll.disabled = !rows.length;
        this.copySelected.textContent = `复制已选 ${this.selected.size}`;
        this.cancelSelected.textContent = `取消已选 ${this.selected.size}`;
        this.copySelected.disabled = this.cancelSelected.disabled = !this.selected.size;
        const fragment = document.createDocumentFragment();
        if (!rows.length) fragment.append(node('p', lib.records.length ? '没有找到匹配的摘录' : '在聊天正文中长按或拖动选字，再轻触“标记”。'));
        const statusCache = new Map();
        for (const record of rows) {
            const item = node('article', null, 'rp-record'); item.setAttribute('role', 'listitem');
            const line = node('div', null, 'rp-record-head');
            const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = this.selected.has(record.id); checkbox.setAttribute('aria-label', `选择标记 ${record.number}`);
            checkbox.addEventListener('change', () => { checkbox.checked ? this.selected.add(record.id) : this.selected.delete(record.id); this.renderRows(); });
            line.append(checkbox, node('strong', `标记 ${record.number}`), node('span', record.source.speaker));
            const status = this.app.status(record, statusCache);
            const meta = node('p', `${status.text} · 消息 ${record.source.messageIndex + 1} · 版本 ${record.source.swipeIndex + 1}\n${new Date(record.createdAt).toLocaleString()}${record.originChat ? ' · 原聊天：' + record.originChat : ''}`, 'rp-meta');
            const excerpt = node('details'); excerpt.append(node('summary', record.text.length > 100 ? record.text.slice(0, 100) + '…' : record.text));
            excerpt.addEventListener('toggle', () => {
                if (excerpt.open && !excerpt.querySelector('pre')) excerpt.append(node('pre', record.text));
            });
            const actions = node('div', null, 'rp-row-actions');
            const locate = button('返回来源', async () => { await this.app.locate(record); this.dialog.close(); });
            locate.disabled = status.text !== '可定位';
            actions.append(button('复制原文', async () => { await copy(record.text); this.say('原文已复制'); }), locate, button('取消标记', () => this.app.remove([record.id])));
            item.append(line, meta, excerpt, actions); fragment.append(item);
        }
        this.list.replaceChildren(fragment);
    }
    selection(candidate, error) {
        this.action.dataset.mode = 'selection';
        this.action.replaceChildren(button('标记', () => {
            if (error) throw new Error(error);
            return this.app.add(candidate);
        }));
        if (candidate) this.action.append(button('复制', () => copy(candidate.text)));
        this.action.hidden = false;
        const rect = candidate?.range.getBoundingClientRect();
        this.action.style.left = `${Math.max(8, Math.min((rect?.left ?? 16), innerWidth - 170))}px`;
        this.action.style.top = `${Math.max(8, Math.min((rect?.bottom ?? 100) + 12, innerHeight - 110))}px`;
    }
    marked(record) {
        this.action.dataset.mode = 'marked';
        this.action.replaceChildren(node('span', `标记 ${record.number}`), button('取消标记', () => this.app.remove([record.id])), button('复制', () => copy(record.text)));
        this.action.hidden = false;
    }
    preview() {
        const last = this.app.transport.last;
        const prepared = this.app.enabled ? material(this.app.library?.records ?? []) : '';
        const header = node('header'); header.append(node('strong', '附加内容核对'), button('关闭', () => this.inspect.close()));
        const state = node('p', '以下为当前准备附加的材料，尚未提交。实际发送受请求启动时的开关和内容库快照控制。');
        const pre = node('pre', prepared || '当前附加内容为零');
        this.inspect.replaceChildren(header, state, pre);
        if (last?.key === this.app.library?.key) this.inspect.append(node('h3', `最近一次请求 · ${last.count} 条`), node('p', `${last.status}\n${last.at}\n${last.capacity ?? ''}`), node('pre', last.content));
        else this.inspect.append(node('p', '当前聊天尚无本插件捕获的提交记录'));
        if (!this.inspect.open) this.inspect.showModal();
    }
    dispose() {
        clearTimeout(this.toastTimer);
        for (const el of [this.bar, this.action, this.toast, this.dialog, this.inspect]) el.remove();
    }
}
