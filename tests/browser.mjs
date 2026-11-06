import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const received = [];
let saveFailure = false;
const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
        let text = ''; for await (const part of req) text += part;
        if (req.url.includes('/generate')) received.push(JSON.parse(text));
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/chats/save' && saveFailure) { res.statusCode = 503; res.end('{"error":"offline"}'); }
        else res.end(req.url.includes('/generate') ? '{"choices":[{"message":{"content":"测试回复"}}]}' : '{"ok":true}');
        return;
    }
    try {
        const path = resolve(root, '.' + (req.url === '/' ? '/tests/fixture.html' : new URL(req.url, 'http://local').pathname));
        if (!path.startsWith(root + '/')) throw new Error('path');
        res.setHeader('Content-Type', {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css'}[extname(path)] ?? 'application/octet-stream');
        res.end(await readFile(path));
    } catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
async function run(name, action) { await action(); results.push({ name, status:'通过（本地夹具）' }); console.log('✓', name); }
const context = await browser.newContext({ viewport:{width:1200,height:900} });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => dialog.accept());
try {
    await page.goto(url); await page.waitForFunction(()=>window.fixtureReady);
    await run('默认关闭；重复句只标记一个位置；准确局部选区；不改写消息', async () => {
        const r = await page.evaluate(async () => {
            const before = JSON.stringify(context.chat);
            const off = app.enabled; await app.setEnabled(true);
            await app.add(selectText(1,'p',3,7));
            const entries = app.painter.entries;
            return { off, text:app.library.records[0].text, range:entries[0].range.toString(), entries:entries.length, same:before===JSON.stringify(context.chat) };
        });
        assert.equal(r.off,false); assert.equal(r.text,'重复句。'); assert.equal(r.range,r.text); assert.equal(r.entries,1); assert.equal(r.same,true);
    });
    await run('幂等、部分重叠拒绝、同句不同位置、取消与撤销原编号', async () => {
        const r = await page.evaluate(async () => {
            await app.add(selectText(1,'p',3,7));
            let overlap=''; try { await app.add(selectText(1,'p',5,9)); } catch(e){ overlap=e.message; }
            await app.add(selectText(1,'p',7,11));
            const ids = app.library.records.map(r=>r.id); await app.remove([ids[0]]);
            app.ui.toast.querySelector('button').click();
            await new Promise(r=>setTimeout(r,100));
            return { overlap, numbers:app.library.records.map(r=>r.number), count:app.painter.entries.length };
        });
        assert.match(r.overlap,/重叠/); assert.deepEqual(r.numbers,[1,2]); assert.equal(r.count,2);
    });
    await run('代码缩进和换行；多段/列表/引用；隐藏文本不混入；跨单元格拒绝', async () => {
        const r = await page.evaluate(async () => {
            const code = selectText(3,'code',0,document.querySelector('.mes[mesid="3"] code').firstChild.length); await app.add(code);
            const root=document.querySelector('.mes[mesid="2"] .mes_text');
            const first=root.querySelector('p').firstChild, last=root.querySelector('blockquote p').firstChild;
            const range=document.createRange(); range.setStart(first,0); range.setEnd(last,last.length); getSelection().removeAllRanges(); getSelection().addRange(range);
            const multi=fixture.captureSelection(); multi.chatKey=app.key(); multi.version=fixture.versionKey(context.chat[2]); await app.add(multi);
            const cells=document.querySelectorAll('td'); range.setStart(cells[0].firstChild,0); range.setEnd(cells[1].firstChild,2); getSelection().removeAllRanges(); getSelection().addRange(range);
            let table=''; try{fixture.captureSelection();}catch(e){table=e.message;}
            return {code:code.text,multi:multi.text,table};
        });
        assert.equal(r.code,'  let x = 1;\n    return x;\n'); assert.match(r.multi,/第一段粗体尾句。\n\n第二段正文。/);
        assert.match(r.multi,/列表甲\n列表乙/); assert.ok(!r.multi.includes('隐藏')); assert.ok(!r.multi.includes('思考')); assert.match(r.table,/单个单元格/);
    });
    await run('选区入口一次点击完成标记，保留复制功能', async () => {
        await page.evaluate(()=>{getSelection().removeAllRanges();selectText(0,'p',0,4);app.scheduleSelection();});
        await page.locator('.rp-action').waitFor({state:'visible'});
        await page.locator('.rp-action button').filter({hasText:/^标记$/}).click();
        await page.waitForFunction(()=>app.library.records.some(r=>r.text==='保留这个'));
        assert.equal(await page.evaluate(()=>CSS.highlights.has('red-pen')),true);
    });
    await run('退出上下文仍完整发送；普通/重生成/继续/切换新回答；Google 格式转换前桥接', async () => {
        await page.evaluate(async () => {
            for (const type of ['normal','regenerate','continue','swipe']) {
                await context.eventSource.emit('GENERATION_STARTED',type,{},false);
                await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,chat_completion_source:type==='continue'?'vertexai':type==='swipe'?'makersuite':'custom',max_tokens:100,messages:[{role:'user',content:'只有最后一轮上下文'}]})});
                await context.eventSource.emit('GENERATION_ENDED');
            }
        });
        assert.equal(received.length,4);
        for (const payload of received) { assert.equal(payload.messages.length,2); const block=payload.messages[0].content; const records=JSON.parse(block.slice(block.indexOf('[\n'))); assert.equal(records.length,5); assert.equal(records[0].text,'重复句。'); assert.equal(records[2].text,'  let x = 1;\n    return x;\n'); assert.equal(payload.messages.at(-1).content,'只有最后一轮上下文'); }
    });
    await run('开关隐藏高亮、后续零附加、后台 quiet 请求不附加', async () => {
        await page.evaluate(async () => {
            await app.setEnabled(false);
            if(CSS.highlights.has('red-pen'))throw new Error('关闭后仍有高亮');
            await context.eventSource.emit('GENERATION_STARTED','normal',{},false);
            await fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify({type:'normal',messages:[]})});
            await context.eventSource.emit('GENERATION_ENDED');
            await app.setEnabled(true);
            await context.eventSource.emit('GENERATION_STARTED','quiet',{},false);
            await fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify({type:'quiet',messages:[]})});
        });
        assert.equal(received.at(-2).messages.length,0); assert.equal(received.at(-1).messages.length,0);
    });
    await run('刷新恢复；聊天隔离；编辑、删除和其他回答版本不误标', async () => {
        await page.reload(); await page.waitForFunction(()=>window.fixtureReady);
        const r=await page.evaluate(async()=>{
            const originalKey=app.key(), originalText=app.library.records[0].text;
            const initial={count:app.library.records.length,enabled:app.enabled};
            context.chatId='聊天 B';context.chatMetadata={integrity:'integrity-b'};await context.eventSource.emit('CHAT_CHANGED');const b=app.library.records.length;
            context.chatId='聊天 A';context.chatMetadata={integrity:'integrity-a'};await context.eventSource.emit('CHAT_CHANGED');
            context.chat[1].mes='新内容';app.paint();const edited=app.status(app.library.records[0]).text;
            context.chat[1]={...fixture.messages[1],swipes:[fixture.messages[1].mes,fixture.messages[1].mes],swipe_id:1}; app.paint();const swipe=app.status(app.library.records[0]).text;
            context.chat.splice(1,1);app.paint();const deleted=app.status(app.library.records[0]).text;
            context.chat=structuredClone(fixture.messages);draw();app.paint();
            return{initial,b,key:originalKey===app.key(),edited,swipe,deleted,text:app.library.records[0].text,originalText};
        });
        assert.deepEqual(r.initial,{count:5,enabled:true});assert.equal(r.b,0);assert.equal(r.key,true);assert.match(r.edited,/修改/);assert.match(r.swipe,/版本当前未显示/);assert.match(r.deleted,/已删除/);assert.equal(r.text,r.originalText);
    });
    await run('原生聊天保存失败不显示成功；IndexedDB 事务失败原库不变', async()=>{
        saveFailure=true;
        const fail=await page.evaluate(async()=>{
            context.chatId='失败测试';context.chatMetadata={integrity:'failure-chat'};await app.refresh();
            let error='';try{await app.add(selectText(0,'p',0,2));}catch(e){error=e.message;}
            return {error,count:app.library.records.length,paint:app.painter.entries.length};
        });
        assert.match(fail.error,/未能确认/);assert.equal(fail.count,0);assert.equal(fail.paint,0);saveFailure=false;
        const aborted=await page.evaluate(async()=>{
            const before=JSON.stringify(await app.store.get('libraries',app.key()));
            try{await app.mutate(app.key(),lib=>{lib.records.push(makeRecord(100,'不应保存'));throw new Error('模拟事务中止');});}catch{}
            return before===JSON.stringify(await app.store.get('libraries',app.key()));
        });assert.equal(aborted,true);
    });
    await run('库内搜索、三态全选、搜索变化清空勾选、备份往返', async()=>{
        const r=await page.evaluate(async()=>{
            context.chatId='聊天 A';context.chatMetadata={integrity:'integrity-a'};await app.refresh();await app.ui.open();
            app.ui.search.value='重复句';app.ui.search.dispatchEvent(new Event('input'));
            app.ui.selectAll.checked=true;app.ui.selectAll.dispatchEvent(new Event('change'));const selected=app.ui.selected.size;
            app.ui.search.value='代码';app.ui.search.dispatchEvent(new Event('input'));const cleared=app.ui.selected.size;
            const {exportBackup,mergeBackup}=await import('/src/core.js');const backup=exportBackup(app.library);const result=await app.mutate(app.key(),lib=>mergeBackup(lib,backup));
            app.ui.dialog.close();return{selected,cleared,skipped:result.value.skipped,count:app.library.records.length};
        });assert.deepEqual(r,{selected:2,cleared:0,skipped:5,count:5});
    });
    await run('聊天重命名保持库；分支只继承消息范围内标记，父子独立', async()=>{
        const result=await page.evaluate(async()=>{
            const parentKey=app.key();context.chatId='聊天 A 已重命名';await app.refresh();const renamed=app.library.records.length;
            const parentRecords=structuredClone(app.library.records);
            context.chatId='分支';context.chatMetadata={integrity:'branch-a',main_chat:'聊天 A 已重命名'};context.chat=context.chat.slice(0,2);draw();await app.refresh();
            const inherited=app.library.records.map(r=>r.number);await app.remove([app.library.records[0].id]);
            const parent=await app.store.get('libraries',parentKey);
            context.chat=structuredClone(fixture.messages);context.chatId='聊天 A';context.chatMetadata={integrity:'integrity-a'};draw();await app.refresh();
            return{renamed,inherited,parentSame:JSON.stringify(parent.records)===JSON.stringify(parentRecords)};
        });assert.equal(result.renamed,5);assert.deepEqual(result.inherited,[1,2,5]);assert.equal(result.parentSame,true);
    });
    await run('相同文字的两个回答版本独立；删除前一版本后不会串位', async()=>{
        const result=await page.evaluate(async()=>{
            context.chatId='回答版本测试';context.chatMetadata={integrity:'version-test'};context.chat=structuredClone(fixture.messages);
            const m=context.chat[1];m.swipes=[m.mes,m.mes];m.swipe_id=0;m.swipe_info=[{send_date:m.send_date},{send_date:'alternate-date'}];draw();await app.refresh();await app.add(selectText(1,'p',3,7));
            m.swipe_id=1;m.send_date='alternate-date';app.paint();const before=app.painter.entries.length;
            await app.add(selectText(1,'p',3,7));const marked=app.painter.entries.map(e=>e.record.number);
            m.swipes.splice(0,1);m.swipe_info.splice(0,1);m.swipe_id=0;
            await context.eventSource.emit('MESSAGE_SWIPE_DELETED',{messageId:1,swipeId:0,newSwipeId:0});
            const after=app.painter.entries.map(e=>e.record.number);const removed=app.status(app.library.records[0]).text;
            context.chat=structuredClone(fixture.messages);context.chatId='聊天 A';context.chatMetadata={integrity:'integrity-a'};draw();await app.refresh();
            return{before,marked,after,removed};
        });assert.equal(result.before,0);assert.deepEqual(result.marked,[2]);assert.deepEqual(result.after,[2]);assert.match(result.removed,/原回答版本已删除/);
    });
    await run('200 条 / 10 万字界面性能与搜索（桌面 Chromium 夹具）', async()=>{
        const metrics=await page.evaluate(async()=>{
            context.chatId='性能测试';context.chatMetadata={integrity:'performance'};await app.refresh();
            await app.mutate(app.key(),lib=>{lib.records=Array.from({length:200},(_,i)=>makeRecord(i,'原文'+String(i).padStart(3,'0')+'字'.repeat(495)));lib.nextNumber=201;});
            let t=performance.now();await app.ui.open();const open=performance.now()-t;
            t=performance.now();app.ui.search.value='原文199';app.ui.search.dispatchEvent(new Event('input'));const search=performance.now()-t;
            app.ui.search.value='';app.ui.search.dispatchEvent(new Event('input'));
            return{openMs:Math.round(open),searchMs:Math.round(search),records:app.library.records.length,chars:app.library.records.reduce((n,r)=>n+r.text.length,0),userAgent:navigator.userAgent};
        });
        results.push({name:'性能实测数值（本地夹具）',...metrics});assert.equal(metrics.chars,100000);assert.ok(metrics.openMs<2000,JSON.stringify(metrics));assert.ok(metrics.searchMs<1000);
        await mkdir(resolve(root,'docs/evidence'),{recursive:true});await page.screenshot({path:resolve(root,'docs/evidence/desktop-fixture.png')});
        await page.evaluate(()=>app.ui.dialog.close());
    });
    await run('停用清理：DOM、事件、观察器、高亮和 fetch 恢复', async()=>{
        const r=await page.evaluate(()=>{const original=app.transport.original;app.dispose();return{fetch:fetch===original,bar:!!document.getElementById('red-pen-bar'),highlight:CSS.highlights.has('red-pen'),listeners:[...context.eventSource.listeners.values()].flat().length};});
        assert.deepEqual(r,{fetch:true,bar:false,highlight:false,listeners:0});
    });
    const mobile=await browser.newContext({viewport:{width:393,height:851},deviceScaleFactor:2,isMobile:true,hasTouch:true});
    const phone=await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));phone.on('dialog',d=>d.accept());
    await phone.goto(url);await phone.waitForFunction(()=>window.fixtureReady);
    await run('手机竖屏触屏选区后点击标记、库操作及无横向溢出（模拟设备）', async()=>{
        await phone.getByRole('button',{name:'红笔：关闭'}).tap();
        await phone.evaluate(()=>{selectText(1,'p',3,7);app.scheduleSelection();});
        await phone.locator('.rp-action').waitFor({state:'visible'});await phone.locator('.rp-action button').filter({hasText:/^标记$/}).tap();
        await phone.waitForFunction(()=>app.library.records.length===1);
        const hit=await phone.evaluate(()=>{const range=app.painter.entries[0].range;range.startContainer.parentElement.scrollIntoView({block:'center'});const r=range.getClientRects()[0];return{x:r.left+4,y:r.top+r.height/2};});
        await phone.touchscreen.tap(hit.x,hit.y);await phone.waitForTimeout(250);
        assert.equal(await phone.locator('.rp-action').isVisible(),true);
        await phone.locator('.rp-action button').filter({hasText:'取消标记'}).tap();await phone.waitForFunction(()=>app.library.records.length===0);
        await phone.locator('.rp-toast button').filter({hasText:'撤销'}).tap();await phone.waitForFunction(()=>app.library.records.length===1);
        await phone.locator('.rp-bar button').filter({hasText:/标记库/}).tap();
        await phone.getByRole('searchbox').fill('重复');
        await phone.getByLabel('全选搜索结果').check();
        assert.equal(await phone.evaluate(()=>app.ui.selected.size),1);
        assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        const bounds=await phone.getByRole('dialog',{name:'当前聊天标记库'}).boundingBox();assert.ok(bounds.width<=393);
        await phone.screenshot({path:resolve(root,'docs/evidence/mobile-fixture.png')});
        // Light host theme uses the same extension styles.
        await phone.evaluate(()=>{document.documentElement.style.cssText='--SmartThemeBodyColor:#222;--SmartThemeBlurTintColor:#fafafa;--SmartThemeBorderColor:#999;color-scheme:light';document.body.style.background='#eee';document.body.style.color='#222';});
        await phone.screenshot({path:resolve(root,'docs/evidence/mobile-light-fixture.png')});
    });
    await mobile.close();
    assert.deepEqual(errors,[]);
    await writeFile(resolve(root,'docs/evidence/browser-results.json'),JSON.stringify({environment:'本地 HTTP 测试夹具，非真实 SillyTavern / 安卓设备',browser:browser.version(),at:new Date().toISOString(),results},null,2));
    console.log(`Browser checks passed: ${results.length}; Chromium ${browser.version()}`);
} finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
