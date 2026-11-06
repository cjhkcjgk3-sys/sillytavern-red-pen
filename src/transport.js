import { clone, material, normalTypes, normalizedType } from './core.js';

export const endpoint = '/api/backends/chat-completions/generate';
export function isGeneration(input, init, origin = location.origin) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
    return url.origin === origin && url.pathname === endpoint && (init?.method ?? input?.method ?? 'GET').toUpperCase() === 'POST';
}
export function appendMaterial(payload, snapshot) {
    if (!Array.isArray(payload.messages)) throw new Error('当前请求格式无法核对，已暂停发送');
    const next = clone(payload);
    const content = material(snapshot.records);
    // Keep the user's latest instruction and an assistant continuation prefix in
    // their original trailing positions. A trailing data-only user turn would
    // change the meaning of native continuation requests.
    let index = next.messages.findLastIndex(message => message.role === 'user');
    if (index < 0) { index = next.messages.findIndex(message => message.role !== 'system'); if (index < 0) index = next.messages.length; }
    if (content) next.messages.splice(index, 0, { role: 'user', content });
    return { payload: next, content, index };
}
export function plainText(messages) {
    let text = '';
    for (const message of messages) {
        if (typeof message.content === 'string') text += message.content + '\n';
        else if (Array.isArray(message.content)) {
            for (const part of message.content) if (typeof part.text === 'string') text += part.text + '\n';
        }
    }
    return text;
}

export class Transport {
    constructor({ host, currentKey, load, enabled, report, notify, ready }) {
        Object.assign(this, { host, currentKey, load, enabled, report, notify, ready });
        this.snapshot = null; this.last = null; this.serial = 0; this.active = false;
    }
    async start(type, options, dryRun) {
        type = normalizedType(type);
        if (dryRun || !normalTypes.has(type)) return;
        const id = ++this.serial;
        const key = this.currentKey();
        // Freeze the switch at generation start, before asynchronous database work.
        const on = this.enabled();
        this.active = true;
        this.snapshot = { id, key, type, enabled: on, records: [], pending: true };
        try {
            await this.ready();
            if (on) {
                if (!key) throw new Error('尚未确定当前聊天，已暂停发送');
                const lib = await this.load(key);
                if (lib?.retired) throw new Error('此聊天内容库已停用，请重新打开聊天');
                if (this.snapshot?.id === id) this.snapshot.records = clone(lib?.records ?? []);
            }
        } catch (e) { if (this.snapshot?.id === id) this.snapshot.error = e.message; }
        if (this.snapshot?.id === id) this.snapshot.pending = false;
    }
    end() { this.active = false; this.snapshot = null; }
    async checkCapacity(payload, context) {
        const capacity = Number(context.chatCompletionSettings?.openai_max_context);
        const output = Number(payload.max_tokens) || 0;
        if (!Number.isFinite(capacity) || capacity <= 0 || !context.getTokenCountAsync) return '剩余容量无法可靠确认';
        // Host tokenizer count is an estimate, especially for images and tools.
        const estimate = Number(await context.getTokenCountAsync(plainText(payload.messages)));
        if (Number.isFinite(estimate) && estimate + output > capacity) throw new Error(`估算输入 ${estimate} Token，加上预留输出 ${output} 已超过上下文容量 ${capacity}；请调整标记或上下文后重试`);
        return '已进行文字 Token 估算；多模态、工具及服务端容量仍以接口结果为准';
    }
    install(target = window) {
        this.target = target; this.original = target.fetch;
        const self = this;
        this.wrapper = async function(input, init) {
            const requestURL = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
            if (self.observeSave && requestURL.origin === location.origin && ['/api/chats/save', '/api/chats/group/save'].includes(requestURL.pathname)) {
                const response = await self.original.call(this, input, init);
                if (response.ok) {
                    try {
                        let body = init?.body ?? (input instanceof Request ? await input.clone().text() : '');
                        const headers = new Headers(init?.headers ?? input?.headers);
                        if (headers.get('Content-Encoding')?.includes('gzip')) body = await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).text();
                        else if (typeof body !== 'string') body = await new Response(body).text();
                        const saved = JSON.parse(body);
                        const data = await response.clone().json();
                        if (!data?.error) self.observeSave(saved);
                    } catch { /* An unrecognized save cannot establish persistence. */ }
                }
                return response;
            }
            if (!self.original || !isGeneration(input, init)) return self.original.call(this, input, init);
            const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
            let payload;
            try { payload = JSON.parse(raw); } catch { return self.original.call(this, input, init); }
            const type = normalizedType(payload.type);
            if (!normalTypes.has(type)) return self.original.call(this, input, init);
            // Direct/background extension calls without a normal host generation
            // have no snapshot and deliberately receive no library.
            const snapshot = self.snapshot ? clone(self.snapshot) : null;
            if (!snapshot || !snapshot.enabled) return self.original.call(this, input, init);
            let audit;
            try {
                if (snapshot.pending) throw new Error('标记库尚未读取完成，请重试');
                if (snapshot.error) throw new Error(snapshot.error);
                if (snapshot.key !== self.currentKey()) throw new Error('请求准备时聊天发生切换，已暂停发送');
                if (!snapshot.records.length) return self.original.call(this, input, init);
                const prepared = appendMaterial(payload, snapshot);
                const capacity = await self.checkCapacity(prepared.payload, self.host());
                // Count and exact content are checked on the actual serialized body.
                const body = JSON.stringify(prepared.payload);
                const wire = JSON.parse(body);
                if (wire.messages[prepared.index]?.content !== material(snapshot.records)) throw new Error('请求中的标记材料核对失败');
                audit = { key: snapshot.key, type, count: snapshot.records.length, content: prepared.content, status: '准备提交', capacity, at: new Date().toISOString() };
                self.last = audit; self.report(audit);
                const response = await self.original.call(this, input, { ...init, body });
                audit.status = response.ok ? '酒馆服务器已接收；模型结果另行确认' : `提交失败（HTTP ${response.status}）`;
                if (response.ok && !prepared.payload.stream && response.headers.get('content-type')?.includes('application/json')) {
                    // A 200 response can still carry a provider error.
                    try { const data = await response.clone().json(); if (data?.error) audit.status = '接口返回错误，生成失败'; } catch { /* non-JSON/stream */ }
                }
                self.report(audit);
                if (!response.ok || audit.status.includes('失败')) self.notify('接口请求失败，全部标记仍已保留。请检查酒馆错误信息后重试');
                return response;
            } catch (e) {
                self.last = { key: snapshot.key, type, count: snapshot.records.length, content: material(snapshot.records), at: new Date().toISOString(), status: '未完成提交：' + e.message };
                self.report(self.last); self.notify(e.message);
                throw e;
            }
        };
        target.fetch = this.wrapper;
    }
    dispose() {
        if (this.target?.fetch === this.wrapper) this.target.fetch = this.original;
        this.snapshot = null; this.active = false; this.observeSave = null;
    }
}
