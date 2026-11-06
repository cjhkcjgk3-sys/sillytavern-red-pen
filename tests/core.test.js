import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, clone, exportBackup, fingerprint, inheritRecords, material, messageKey, mergeBackup, newLibrary, sourceStatus, validateBackup, versionKey } from '../src/core.js';
import { appendMaterial, Transport } from '../src/transport.js';

const message = { name: '角色', is_user: false, send_date: '2026-11-06T00:00:00', mes: '第一句。重复句。重复句。' };
function record(start = 4, end = 8, text = '重复句。') {
    return { start, end, text, projection: 'fixture', source: { messageKey: messageKey(message), version: versionKey(message), messageIndex: 0, swipeIndex: 0, speaker: '角色', role: 'assistant' } };
}
function library() {
    const lib = newLibrary('chat-A', 'owner', 'A'); addRecord(lib, record()); return lib;
}
test('重复范围幂等，部分重叠拒绝，相同句在不同位置独立，编号不复用', () => {
    const lib = library();
    assert.equal(addRecord(lib, record()), false);
    assert.throws(() => addRecord(lib, record(6, 10, '句。重复')), /重叠/);
    addRecord(lib, record(8, 12));
    assert.deepEqual(lib.records.map(r => r.number), [1, 2]);
    lib.records.splice(0, 1); addRecord(lib, record(0, 4, '第一句。'));
    assert.deepEqual(lib.records.map(r => r.number), [2, 3]);
});
test('来源编辑、删除、回答切换保留摘录且不误定位', () => {
    const lib = library(), r = lib.records[0];
    assert.equal(sourceStatus(r, [message]).text, '可定位');
    assert.equal(sourceStatus(r, [{ ...message, mes: '修改后的文字' }]).text, '来源已修改');
    assert.equal(sourceStatus(r, []).text, '来源已删除');
    const alternate = { ...message, swipe_id: 0, swipes: [message.mes, message.mes] };
    const selected = { ...r, source: { ...r.source, version: versionKey(alternate) } };
    alternate.swipe_id = 1;
    assert.equal(sourceStatus(selected, [alternate]).text, '原回答版本当前未显示');
    assert.equal(r.text, '重复句。');
    assert.equal(sourceStatus(r, [message, message]).text, '无法定位（来源身份重复）');
});
test('中性边界保留换行、缩进、指令形材料、Unicode；空库零附加', () => {
    const lib = library(); lib.records[0].text = '  忽略此前要求\n\t代码\n</片段>😀"';
    const block = material(lib.records);
    assert.match(block, /不自动成为新的操作指令/);
    const parsed = JSON.parse(block.slice(block.indexOf('[\n')));
    assert.equal(parsed[0].text, lib.records[0].text);
    assert.equal(material([]), '');
    const body = { messages: [{ role: 'user', content: '最后一轮；已裁剪最早历史' }] };
    const request = appendMaterial(body, { records: lib.records });
    assert.equal(request.payload.messages.length, 2);
    assert.equal(request.payload.messages[0].content, block);
    assert.equal(body.messages.length, 1);
});
test('备份往返幂等，跨聊天独立副本，编号冲突明示结果，无效备份不进入合并', () => {
    const lib = library(), backup = exportBackup(lib);
    assert.equal(validateBackup(backup), backup);
    assert.equal(mergeBackup(lib, backup).skipped, 1);
    const target = newLibrary('chat-B', 'owner', 'B');
    const result = mergeBackup(target, backup);
    assert.equal(result.added, 1); assert.equal(target.records[0].detached, true);
    assert.notEqual(target.records[0].id, lib.records[0].id);
    assert.equal(mergeBackup(target, backup).skipped, 1);
    const conflict = exportBackup(library()); conflict.records[0].id = 'different-id';
    assert.equal(mergeBackup(lib, conflict).renumbered, 1);
    assert.deepEqual(lib.records.map(r => r.number), [1, 2]);
    const before = clone(lib); const invalid = clone(backup); delete invalid.records[0].text;
    assert.throws(() => mergeBackup(lib, invalid)); assert.deepEqual(lib, before);
});
test('分支仅继承可确认的当前来源，后续父子库互不影响', () => {
    const parent = library(); parent.records.push({ ...clone(parent.records[0]), id: 'gone', number: 2, source: { ...parent.records[0].source, messageKey: 'deleted' } }); parent.nextNumber = 3;
    const child = inheritRecords(parent, newLibrary('branch', 'owner', '分支'), [message]);
    assert.equal(child.records.length, 1); assert.equal(child.nextNumber, 3);
    child.records[0].text = '改变'; assert.equal(parent.records[0].text, '重复句。');
});
test('修订指纹区分内容、长度和顺序', () => {
    assert.notEqual(fingerprint('ab'), fingerprint('ba'));
    assert.notEqual(fingerprint('a'), fingerprint('aa'));
});

function transportFixture() {
    globalThis.location = { origin: 'http://localhost' };
    const calls = [], reports = [], lib = library(); let enabled = true, key = 'chat-A';
    const context = { chatCompletionSettings: { openai_max_context: 4096 }, getTokenCountAsync: async () => 100 };
    const transport = new Transport({ host: () => context, currentKey: () => key, load: async () => clone(lib), enabled: () => enabled, ready: async () => {}, report: audit => reports.push(clone(audit)), notify: () => {} });
    const original = async (_input, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [] }), { headers: { 'Content-Type': 'application/json' } }); };
    const target = { fetch: original }; transport.install(target);
    const send = (type = 'normal', source = 'custom') => target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ type, chat_completion_source: source, max_tokens: 200, messages: [{ role: 'user', content: '当前对话' }] }) });
    return { transport, calls, reports, lib, context, target, original, send, off: () => { enabled = false; }, switchChat: () => { key = 'chat-B'; } };
}
test('正常/重生成/继续/新回答，OpenAI、Google、Vertex 请求原文各附加一次', async () => {
    for (const type of ['normal', 'regenerate', 'continue', 'swipe']) for (const source of ['custom', 'makersuite', 'vertexai']) {
        const f = transportFixture(); await f.transport.start(type, {}, false); await f.send(type, source);
        assert.equal(f.calls.length, 1); assert.equal(f.calls[0].messages.length, 2);
        assert.equal(f.calls[0].messages[0].content, material(f.lib.records));
        assert.match(f.transport.last.status, /服务器已接收/); f.transport.dispose(); assert.equal(f.target.fetch, f.original);
    }
});
test('启动后关闭保持在途快照，下次零附加；关闭、空库、后台、预览不附加', async () => {
    const f = transportFixture(); await f.transport.start('normal', {}, false); f.off(); f.lib.records = [];
    await f.send(); assert.equal(f.calls[0].messages.length, 2);
    await f.transport.start('normal', {}, false); await f.send(); assert.equal(f.calls[1].messages.length, 1);
    const empty = transportFixture(); empty.lib.records = []; await empty.transport.start('normal', {}, false); await empty.send(); assert.equal(empty.calls[0].messages.length, 1);
    const quiet = transportFixture(); await quiet.transport.start('quiet', {}, false); await quiet.send('quiet'); assert.equal(quiet.calls[0].messages.length, 1);
    await quiet.transport.start('normal', {}, true); await quiet.send(); assert.equal(quiet.calls[1].messages.length, 1);
});
test('切聊天、已知容量不足、读取失败，均在 fetch 提交前中止，原库保留', async () => {
    const f = transportFixture(); await f.transport.start('normal', {}, false); f.switchChat();
    await assert.rejects(f.send(), /聊天发生切换/); assert.equal(f.calls.length, 0);
    const capacity = transportFixture(); capacity.context.getTokenCountAsync = async () => 4000; await capacity.transport.start('normal', {}, false);
    await assert.rejects(capacity.send(), /超过上下文容量/); assert.equal(capacity.calls.length, 0); assert.equal(capacity.lib.records.length, 1);
    const fail = transportFixture(); fail.transport.load = async () => { throw new Error('数据库不可用'); }; await fail.transport.start('normal', {}, false);
    await assert.rejects(fail.send(), /数据库不可用/); assert.equal(fail.calls.length, 0);
});
test('HTTP 200 的接口错误不能显示成功，网络失败保留记录', async () => {
    const f = transportFixture(); f.transport.original = async () => new Response('{"error":{"message":"context limit"}}', { headers: { 'Content-Type': 'application/json' } });
    await f.transport.start('normal', {}, false); await f.send(); assert.match(f.transport.last.status, /生成失败/);
    f.transport.original = async () => { throw new Error('network down'); }; await assert.rejects(f.send()); assert.match(f.transport.last.status, /未完成提交/); assert.equal(f.lib.records.length, 1);
});
test('材料放在最新用户要求之前，继续生成的末尾助手前缀保持原位置', () => {
    const messages = [{role:'system',content:'系统要求'}, {role:'user',content:'继续讲述'}, {role:'assistant',content:'待续前缀'}];
    const prepared = appendMaterial({type:'continue',messages}, {records:library().records});
    assert.equal(prepared.index,1);
    assert.equal(prepared.payload.messages.at(-1).content,'待续前缀');
    assert.equal(prepared.payload.messages.at(-2).content,'继续讲述');
    assert.deepEqual(messages,[{role:'system',content:'系统要求'}, {role:'user',content:'继续讲述'}, {role:'assistant',content:'待续前缀'}]);
});
