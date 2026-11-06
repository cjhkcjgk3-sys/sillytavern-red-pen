import { addRecord, clone, exportBackup, fingerprint, inheritRecords, messageKey, mergeBackup, newLibrary, sourceStatus, uuid, validateBackup, versionKey } from './core.js';
import { chatIdentity, needsSeparateScope, SCOPE } from './compat.js';
import { Store } from './store.js';
import { captureSelection, messageRootOf, Painter, project, rangeFor } from './dom.js';
import { Transport } from './transport.js';
import { UI } from './ui.js';

const ID = 'sillytavern-red-pen';
const host = () => globalThis.SillyTavern.getContext();

export class RedPen {
    constructor(getHost = host, user = 'default-user') {
        this.host = getHost; this.user = user; this.store = new Store(); this.painter = new Painter();
        this.listeners = []; this.enabled = false; this.library = null; this.epoch = 0; this.saved = new Set(); this.alive = true;
        this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(ID) : null;
    }
    identity(context = this.host()) {
        return chatIdentity(context, this.user);
    }
    key() { return this.identity()?.key; }
    async initialize() {
        await this.store.open();
        // CSS Custom Highlight is preferred, but a positioned overlay paints the
        // same ranges when the browser lacks it, so marking is never disabled.
        this.highlightMode = this.painter.native ? 'native' : 'overlay';
        this.canHighlight = true;
        this.enabled = (await this.store.get('settings', this.user + ':enabled')) === true;
        this.ui = new UI(this);
        this.transport = new Transport({ host: this.host, currentKey: () => this.key(), load: key => this.store.get('libraries', key), enabled: () => this.enabled, report: () => {}, notify: message => this.ui.say(message), ready: () => this.loading ?? Promise.resolve() });
        this.transport.observeSave = data => {
            const integrity = data.chat?.[0]?.chat_metadata?.integrity;
            const current = this.host();
            const identity = this.identity(current);
            const matchingOwner = current.groupId ? data.id === current.chatId : data.avatar_url === current.characters[current.characterId]?.avatar && data.file_name === current.chatId;
            if (identity && matchingOwner && integrity === current.chatMetadata.integrity && data.chat[0].chat_metadata[SCOPE] === current.chatMetadata[SCOPE]) this.saved.add(identity.key);
        };
        this.transport.install();
        this.interceptor = (_chat, _size, abort) => {
            const snapshot = this.transport.snapshot;
            if (!snapshot?.enabled) return;
            const error = snapshot.error || (snapshot.records.length && this.host().mainApi !== 'openai' ? '红笔发送需要酒馆的聊天补全连接；请切换到 OpenAI 兼容、Google AI Studio 或 Vertex AI 连接后重试' : null);
            if (error) { abort(true); this.ui.say(error); }
        };
        globalThis.redPenGenerationInterceptor = this.interceptor;
        const context = this.host();
        const on = (name, fn) => {
            const type = context.eventTypes[name];
            if (type) { context.eventSource.on(type, fn); this.listeners.push(() => context.eventSource.removeListener(type, fn)); }
        };
        on('CHAT_CHANGED', () => { this.ui.dialog.close(); this.ui.inspect.close(); this.ui.action.hidden = true; return this.refresh(); });
        on('CHAT_RENAMED', () => this.refresh());
        on('GENERATION_STARTED', (...args) => this.transport.start(...args));
        on('GENERATION_ENDED', () => { this.transport.end(); this.paint(); });
        on('GENERATION_STOPPED', () => { this.transport.end(); this.paint(); });
        for (const event of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_UPDATED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED']) on(event, () => this.schedulePaint());
        on('MESSAGE_SWIPE_DELETED', async ({ messageId, swipeId }) => {
            const key = this.key(), message = this.host().chat[messageId];
            const oldKey = this.messageKeys?.[messageId] ?? (message && messageKey(message));
            if (!key || !message || !oldKey || !this.library?.records.some(r => r.source.messageKey === oldKey)) return;
            await this.mutate(key, lib => {
                for (const r of lib.records.filter(r => !r.detached && r.source.messageKey === oldKey && !r.source.versionRemoved)) {
                    if (r.source.swipeIndex === swipeId) { r.source.versionRemoved = true; continue; }
                    const index = r.source.swipeIndex > swipeId ? r.source.swipeIndex - 1 : r.source.swipeIndex;
                    const raw = message.swipes?.[index] ?? message.mes;
                    if (!r.source.rawHash || r.source.rawHash !== fingerprint(raw)) { r.source.versionUncertain = true; continue; }
                    r.source.swipeIndex = index; r.source.version = versionKey(message, index); r.source.messageKey = messageKey(message);
                }
            });
        });
        const retire = async label => {
            const identity = this.identity();
            const libraries = await this.store.all();
            for (const lib of libraries.filter(l => l.owner.startsWith(JSON.stringify([this.user]).slice(0, -1)) && l.label === label && (!identity || l.owner === identity.owner))) {
                await this.store.update(lib.key, lib, target => { target.retired = true; });
            }
            await this.refresh();
        };
        on('CHAT_DELETED', retire); on('GROUP_CHAT_DELETED', retire);
        // Touch browsers differ in which of these they fire for a long-press
        // selection, so every plausible trigger is observed.
        for (const type of ['selectionchange', 'pointerup', 'mouseup', 'touchend', 'contextmenu', 'keyup']) {
            this.listen(document, type, () => this.scheduleSelection(type));
        }
        // Some Android browsers only commit the selection without notifying, so
        // poll briefly after a touch starts inside the chat.
        this.listen(document, 'touchstart', e => { if (this.enabled && e.target?.closest?.('#chat')) this.watchSelection(); }, { passive: true });
        this.listen(document, 'pointerdown', e => { if (this.enabled && e.pointerType !== 'mouse' && e.target?.closest?.('#chat')) this.watchSelection(); }, { passive: true });
        this.listen(document, 'keydown', e => { if (e.key === 'Escape') this.ui.action.hidden = true; });
        this.listen(document, 'click', e => {
            if (!this.enabled || !e.target.closest('.mes_text') || !window.getSelection()?.isCollapsed) return;
            const hit = this.painter.hit(e.clientX, e.clientY);
            if (hit) {
                this.ui.marked(hit.record);
                this.ui.action.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - 280))}px`;
                this.ui.action.style.top = `${Math.max(8, Math.min(e.clientY + 16, innerHeight - 110))}px`;
            } else this.ui.action.hidden = true;
        });
        this.listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') this.refresh(); });
        if (this.channel) this.channel.onmessage = async event => {
            if (event.data?.user !== this.user) return;
            if (event.data.setting) { this.enabled = (await this.store.get('settings', this.user + ':enabled')) === true && this.canHighlight; this.ui.action.hidden = true; }
            await this.refresh();
        };
        const chat = document.getElementById('chat');
        if (chat) { this.observer = new MutationObserver(() => this.schedulePaint()); this.observer.observe(chat, { subtree: true, childList: true, characterData: true }); }
        await this.refresh();
    }
    listen(target, type, fn, options) {
        target.addEventListener(type, fn, options);
        this.listeners.push(() => target.removeEventListener(type, fn, options));
    }
    async prepareIdentity() {
        const context = this.host(), metadata = context.chatMetadata;
        const initial = this.identity(context);
        if (!initial) return null;
        if (this.scopePreparation?.metadata === metadata) return this.scopePreparation.promise;
        const preparation = { metadata };
        preparation.promise = (async () => {
            const lib = await this.store.get('libraries', initial.key);
            if (this.host().chatMetadata !== metadata || this.host().chatId !== initial.label || !this.alive) throw new Error('聊天已切换，已停止准备标记库');
            if (!needsSeparateScope(context, initial, lib)) return initial;
            const previous = metadata[SCOPE];
            metadata[SCOPE] = uuid();
            const separated = this.identity(context);
            try {
                await context.saveMetadata();
                if (!this.saved.has(separated.key)) throw new Error('聊天隔离标识未能保存，未启用此聊天的标记库；请检查服务器连接后重试');
                return separated;
            } catch (e) {
                if (previous === undefined) delete metadata[SCOPE]; else metadata[SCOPE] = previous;
                throw e;
            }
        })();
        this.scopePreparation = preparation;
        try { return await preparation.promise; } finally { if (this.scopePreparation === preparation) this.scopePreparation = null; }
    }
    async refresh() {
        const epoch = ++this.epoch;
        this.painter.clear();
        this.library = null; this.ui.update();
        if (!this.identity()) return;
        this.loading = (async () => {
            const identity = await this.prepareIdentity();
            if (!this.alive || epoch !== this.epoch || identity.key !== this.key()) return;
            let lib = await this.store.get('libraries', identity.key);
            if (!lib) {
                let initial = newLibrary(identity.key, identity.owner, identity.label);
                const mainChat = this.host().chatMetadata?.main_chat;
                if (mainChat) {
                    const parents = (await this.store.all()).filter(l => l.owner === identity.owner && (l.label === mainChat || l.aliases?.includes(mainChat)) && !l.retired);
                    if (parents.length === 1 && this.key() === identity.key) initial = inheritRecords(parents[0], initial, this.host().chat);
                }
                initial.branchParent = mainChat || null;
                lib = (await this.store.update(identity.key, initial, () => {})).library;
            } else if (lib.label !== identity.label || !Object.prototype.hasOwnProperty.call(lib, 'branchParent')) lib = (await this.store.update(identity.key, lib, l => {
                if (l.label !== identity.label) l.aliases = [...new Set([...(l.aliases ?? []), l.label])];
                l.label = identity.label; l.branchParent = this.host().chatMetadata?.main_chat || null;
            })).library;
            if (!this.alive || epoch !== this.epoch || identity.key !== this.key()) return;
            this.library = lib; this.ui.update(); this.paint();
        })();
        try { await this.loading; } catch (e) { if (epoch === this.epoch) { this.library = null; this.ui.say('内容库读取失败：' + e.message); this.ui.update(); } throw e; }
    }
    async mutate(key, fn) {
        const current = await this.store.get('libraries', key);
        if (!current || current.retired) throw new Error('当前内容库不可用，请重新打开聊天');
        const result = await this.store.update(key, current, fn);
        if (this.key() === key && this.alive) { this.library = result.library; this.ui.update(); this.paint(); }
        this.channel?.postMessage({ user: this.user, key });
        return result;
    }
    async setEnabled(on) {
        await this.store.setting(this.user + ':enabled', on);
        this.enabled = on; this.ui.action.hidden = true; this.ui.update(); this.paint();
        this.channel?.postMessage({ user: this.user, setting: true });
        if (this.transport.active) this.ui.say('设置已保存，将作用于之后的请求；当前请求保持启动时的标记状态');
    }
    scheduleSelection(source = 'selectionchange') {
        clearTimeout(this.selectionTimer);
        this.selectionTimer = setTimeout(() => this.applySelection(source), 130);
    }
    watchSelection() {
        if (!this.enabled || this.selectionWatch) return;
        const started = Date.now();
        this.selectionWatch = setInterval(() => {
            if (!this.enabled || Date.now() - started > 2500) { clearInterval(this.selectionWatch); this.selectionWatch = null; return; }
            this.applySelection('poll');
        }, 180);
    }
    /** Single place that decides whether the floating 标记 entry is shown.
     * Every outcome is recorded so 状态检查 can explain a missing entry. */
    applySelection(source = 'selectionchange') {
        if (this.ui.actionPointerActive) return;
        const dialog = this.ui.dialog.open || this.ui.inspect.open || Boolean(this.controlPanel?.dialog?.open);
        const selection = globalThis.getSelection?.() ?? null;
        // The touch poll fires repeatedly; only re-project when the selection
        // actually changed, so long messages are not walked every 180 ms.
        const signature = selection ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] : null;
        const previous = this.selectionSignature;
        if (signature && previous && signature.every((value, index) => value === previous[index])) return;
        this.selectionSignature = signature;
        const diag = { at: new Date().toISOString(), source, enabled: this.enabled, dialog, collapsed: !selection || selection.isCollapsed, ranges: selection?.rangeCount ?? 0, state: '', message: '' };
        this.selectionDiag = diag;
        if (!this.enabled || dialog) { diag.state = this.enabled ? 'dialog' : 'disabled'; this.hideAction(); return; }
        if (diag.collapsed || !diag.ranges) { diag.state = 'empty'; this.hideAction(); return; }
        const root = messageRootOf(selection.getRangeAt(0).startContainer) ?? messageRootOf(selection.getRangeAt(0).endContainer);
        if (!root) { diag.state = 'outside'; this.hideAction(); return; }
        try {
            const candidate = captureSelection(selection);
            if (!candidate) throw new Error('没有可标记的可见正文');
            const message = this.host().chat?.[candidate.index];
            if (!message) throw new Error('这条消息不在当前聊天中，请刷新页面后重试');
            candidate.chatKey = this.key();
            candidate.version = versionKey(message);
            this.lastCandidate = candidate;
            diag.state = 'ok';
            this.ui.selection(candidate);
        } catch (e) {
            diag.state = 'error';
            diag.message = e.message;
            this.ui.selection(null, e.message);
        }
    }
    hideAction() { if (this.ui.action.dataset.mode !== 'marked') this.ui.action.hidden = true; }
    /** Manual entry for 状态检查 / hosts where the floating entry is unreachable. */
    async markSelection() {
        if (!this.enabled) throw new Error('标记已暂停，请先开启标记');
        if (!this.lastCandidate) throw new Error('没有检测到有效选区。请回到正文选中文字后，再点这里。');
        return this.add(this.lastCandidate);
    }
    async ensureChatIdentitySaved(key) {
        if (this.saved.has(key)) return;
        if (this.key() !== key) throw new Error('聊天已切换，请重新选择');
        await this.host().saveMetadata();
        if (!this.saved.has(key)) throw new Error('未能确认聊天来源已保存；标记尚未添加，请检查服务器连接后重试');
    }
    async add(candidate) {
        if (!this.enabled) throw new Error('标记已暂停');
        const key = this.key();
        if (!candidate || !key || key !== candidate.chatKey || !candidate.root.isConnected) throw new Error('选区来源已变化，请重新选字');
        const context = this.host(), message = context.chat[candidate.index];
        if (!message || message.is_system) throw new Error('请选择用户消息或模型回复');
        const processor = context.streamingProcessor;
        if (candidate.index === context.chat.length - 1 && !message.is_user && (this.transport.active || (processor && !processor.isFinished && !processor.isStopped))) throw new Error('这条回答尚未完成，请在生成结束后标记');
        const sourceKey = messageKey(message);
        if (!sourceKey || context.chat.filter(m => messageKey(m) === sourceKey).length !== 1) throw new Error('无法唯一确认来源消息，未添加标记');
        if (versionKey(message) !== candidate.version) throw new Error('回答版本已变化，请重新选字');
        const projection = project(candidate.root);
        if (projection.hash !== candidate.projection || projection.text.slice(candidate.start, candidate.end) !== candidate.text) throw new Error('正文已变化，请重新选字');
        this.ui.say('正在保存标记…');
        await this.ensureChatIdentitySaved(key);
        if (key !== this.key() || !this.enabled || versionKey(this.host().chat[candidate.index]) !== candidate.version || project(candidate.root).hash !== candidate.projection) throw new Error('来源或开关已变化，请重新选字');
        const result = await this.mutate(key, lib => addRecord(lib, {
            text: candidate.text, start: candidate.start, end: candidate.end, projection: candidate.projection,
            source: { messageKey: sourceKey, version: candidate.version, rawHash: fingerprint(message.mes), speaker: message.name, role: message.is_user ? 'user' : 'assistant', messageIndex: candidate.index, swipeIndex: message.swipe_id ?? 0 },
        }));
        this.ui.action.hidden = true; window.getSelection()?.removeAllRanges();
        const notice = result.value ? '已标记并保存' : '这段原文已标记，无需重复添加';
        this.ui.say(notice);
        return notice;
    }
    status(record, cache = new Map()) {
        const sourceKey = record.source.messageKey + ':' + record.source.version;
        if (!cache.has(sourceKey)) cache.set(sourceKey, sourceStatus(record, this.host().chat));
        const status = cache.get(sourceKey);
        if (status.text === '可定位') {
            const root = document.querySelector(`#chat .mes[mesid="${status.index}"] .mes_text`);
            if (root && !cache.has(root)) cache.set(root, project(root));
            if (root && cache.get(root).hash !== record.projection) return { ...status, text: '无法定位（显示内容已变化）' };
        }
        return status;
    }
    schedulePaint() {
        clearTimeout(this.paintTimer);
        this.paintTimer = setTimeout(() => { this.paint(); if (this.ui.dialog.open) this.ui.renderRows(); }, 180);
    }
    paint() {
        if (!this.alive) return;
        this.messageKeys = this.host().chat.map(messageKey);
        this.painter.clear();
        if (!this.enabled || !this.library || this.library.key !== this.key() || this.library.retired) return;
        const entries = [], projections = new Map(), statuses = new Map(), changed = [];
        for (const record of this.library.records) {
            const sourceKey = record.source.messageKey + ':' + record.source.version;
            if (!statuses.has(sourceKey)) statuses.set(sourceKey, sourceStatus(record, this.host().chat));
            const status = statuses.get(sourceKey);
            if (status.text !== '可定位') continue;
            const root = document.querySelector(`#chat .mes[mesid="${status.index}"] .mes_text`);
            if (!root) continue;
            if (!projections.has(root)) projections.set(root, project(root));
            const projection = projections.get(root);
            if (projection.hash !== record.projection || projection.text.slice(record.start, record.end) !== record.text) { changed.push(record); continue; }
            const range = rangeFor(projection, record.start, record.end);
            if (range) entries.push({ range, record });
        }
        this.painter.paint(entries);
        this.reportPaintGap(changed);
    }
    /** A message whose rendered text changed (line numbers, re-render, another
     * extension rewriting the DOM) silently loses its red line. Say so once,
     * and only when no generation is running, instead of leaving the user
     * thinking the mark disappeared. */
    reportPaintGap(records) {
        if (!records.length || this.transport?.active) return;
        const key = `${this.library?.key}|${records.map(r => r.id).sort().join(',')}`;
        if (this.paintGapKey === key) return;
        this.paintGapKey = key;
        const numbers = records.map(r => `标记 ${r.number}`).join('、');
        this.ui.say(`${numbers} 所在消息的显示内容与标记时不同，红线暂不显示；摘录仍保存在标记库中，可核对原文或重新选择。`);
    }
    async remove(ids) {
        const key = this.key();
        const removed = (await this.mutate(key, lib => { const rows = clone(lib.records.filter(r => ids.includes(r.id))); lib.records = lib.records.filter(r => !ids.includes(r.id)); return rows; })).value;
        this.ui.action.hidden = true;
        this.ui.say(`已取消 ${removed.length} 条标记`, async () => {
            await this.mutate(key, lib => {
                for (const r of removed) {
                    if (lib.records.some(x => x.number === r.number && x.id !== r.id)) throw new Error('编号发生冲突，未执行撤销');
                    if (!lib.records.some(x => x.id === r.id)) lib.records.push(r);
                }
                lib.records.sort((a, b) => a.number - b.number);
            });
        });
    }
    async locate(record) {
        const status = this.status(record);
        if (status.text !== '可定位') throw new Error(status.text);
        let root = document.querySelector(`#chat .mes[mesid="${status.index}"]`);
        if (!root) throw new Error('来源尚未加载，请先在聊天中向上加载历史消息');
        root.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        root.classList.add('rp-locate');
        const timer = setTimeout(() => root.classList.remove('rp-locate'), 1800); this.listeners.push(() => { clearTimeout(timer); root.classList.remove('rp-locate'); });
    }
    download() {
        if (!this.library) throw new Error('当前没有可导出的内容库');
        const url = URL.createObjectURL(new Blob([JSON.stringify(exportBackup(this.library), null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = '红笔标记备份.json'; link.click();
        const timer = setTimeout(() => URL.revokeObjectURL(url), 1000); this.listeners.push(() => { clearTimeout(timer); URL.revokeObjectURL(url); });
    }
    async importBackup(backup) {
        validateBackup(backup);
        const lib = this.library, key = this.key();
        if (!lib || key !== lib.key) throw new Error('请先进入目标聊天');
        const preview = mergeBackup(clone(lib), backup);
        if (!confirm(`恢复 ${backup.records.length} 条备份到“${lib.label}”？\n预计新增 ${preview.added} 条，跳过重复 ${preview.skipped} 条，重新分配编号 ${preview.renumbered} 条。\n${key === backup.chatKey ? '编号冲突将分配新编号，现有内容不会覆盖。' : '作为独立副本恢复，不自动在正文标红。'}`)) return;
        if (key !== this.key()) throw new Error('目标聊天已切换，恢复已取消');
        await this.ensureChatIdentitySaved(key);
        const result = (await this.mutate(key, target => mergeBackup(target, backup))).value;
        this.ui.say(`恢复完成：新增 ${result.added} 条，重复 ${result.skipped} 条，重新编号 ${result.renumbered} 条`);
    }
    dispose() {
        this.alive = false; this.epoch++; clearTimeout(this.selectionTimer); clearTimeout(this.paintTimer);
        clearInterval(this.selectionWatch); this.selectionWatch = null;
        this.observer?.disconnect(); this.channel?.close();
        for (const cleanup of this.listeners.splice(0)) cleanup();
        this.painter.dispose?.(); this.painter.clear(); this.transport?.dispose(); this.store.close(); this.ui?.dispose();
        this.controlPanel?.unbind();
        if (globalThis.redPenGenerationInterceptor === this.interceptor) delete globalThis.redPenGenerationInterceptor;
    }
}

function preflight(context) {
    const missing = ['getCurrentChatId', 'saveMetadata', 'getTokenCountAsync'].filter(name => typeof context[name] !== 'function');
    if (missing.length) throw new Error(`当前酒馆缺少 ${missing.join('、')}，请在扩展列表里升级酒馆后重试`);
    const gaps = [];
    if (!context.eventTypes?.GENERATION_STARTED || !context.eventTypes?.GENERATION_ENDED) gaps.push('生成事件');
    if (!context.accountStorage) gaps.push('账号存储');
    if (!context.chatCompletionSettings) gaps.push('聊天补全设置');
    if (!context.eventSource) gaps.push('事件总线');
    if (gaps.length) throw new Error(`当前酒馆版本缺少 ${gaps.join('、')}；本插件在 1.18 / 1.19 上验证，请升级酒馆`);
    if (!globalThis.indexedDB) throw new Error('当前浏览器无法使用持久保存，请允许此站点保存数据后重试');
}
async function hostVersion() {
    try {
        const response = await fetch('/version', { headers: { accept: 'application/json' } });
        if (!response.ok) return '';
        const data = await response.json();
        return String(data?.pkgVersion ?? data?.version ?? '');
    } catch { return ''; }
}
export async function createApplication(controlPanel) {
    const context = host(); preflight(context);
    const { getCurrentUserHandle } = await import('/scripts/user.js');
    const app = new RedPen(host, getCurrentUserHandle());
    app.hostVersion = await hostVersion();
    // 1.12+ can load the extension, but only 1.18 / 1.19 were verified.
    app.versionWarning = app.hostVersion && !/^1\.(18|19)\./.test(app.hostVersion) ? `当前酒馆 ${app.hostVersion} 低于验证基线 1.18.0，基础标记可用，其余效果未验证` : '';
    app.controlPanel = controlPanel;
    try { await app.initialize(); return app; } catch (e) { app.dispose(); throw e; }
}
