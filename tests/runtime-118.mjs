// Run only against a disposable SillyTavern 1.18 server with an empty test data
// directory. This creates a test character, chats, settings and branch metadata.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

if (process.env.RED_PEN_RUNTIME_TEST !== 'isolated-1.18') throw new Error('Set RED_PEN_RUNTIME_TEST=isolated-1.18 only for a disposable test instance');
const url = process.env.ST_118_URL ?? 'http://127.0.0.1:8128';
if (!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error('Only a local disposable instance is allowed');
const mockRequests = [], wire = [], results = [], errors = [];
const mock = createServer(async (req,res) => {
    let raw=''; for await (const part of req) raw+=part;
    res.setHeader('Content-Type','application/json');
    if (req.method !== 'POST') { res.end('{"object":"list","data":[{"id":"red-pen-mock"}]}'); return; }
    const body=JSON.parse(raw); mockRequests.push({path:req.url.split('?')[0],body});
    const content=`本地模拟回复 ${mockRequests.length}：雨城依旧，旧设定继续。`;
    if (body.contents) res.end(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:content}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:15,totalTokenCount:115}}));
    else res.end(JSON.stringify({id:'mock-'+mockRequests.length,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:15,total_tokens:115}}));
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const mockURL=`http://127.0.0.1:${mock.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1200,height:900}});
page.on('pageerror',e=>errors.push(e.message));
page.on('request',req=>{ if(new URL(req.url()).pathname==='/api/backends/chat-completions/generate') wire.push(req.postDataJSON()); });
page.on('dialog',dialog=>dialog.accept());
const pluginPath='/scripts/extensions/third-party/red-pen/index.js';
const root=resolve(import.meta.dirname,'..');
async function record(name,action){const data=await action();results.push({name,status:'通过（隔离真实酒馆，模型为本地模拟接口）',...data});console.log('✓',name);}
async function ready(){
    await page.waitForFunction(()=>document.getElementById('red-pen-menu-item')||document.querySelector('dialog[open] .onboarding'),null,{timeout:60000});
    if(await page.locator('dialog[open] .onboarding').count()){
        await page.locator('dialog[open] .popup-input').fill('红笔测试员');
        await page.locator('dialog[open] .popup-button-ok').click();
    }
    await page.locator('#red-pen-menu-item').waitFor({state:'attached',timeout:60000});
    await page.waitForFunction(()=>SillyTavern.getContext().eventSource.autoFireLastArgs.has('app_ready'),null,{timeout:60000});
    await page.evaluate(async path=>{window.rpApp=await(await import(path)).initialize();},pluginPath);
}
async function mark(index,text){
    // Native chat loading schedules a delayed composer focus. Wait until that
    // settles before establishing a range, as a user would after opening chat.
    await page.waitForTimeout(400);
    await page.evaluate(({index,text})=>{
        const root=document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
        if(!root)throw new Error('Message is not rendered: '+index);
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
        while((node=walker.nextNode())){const start=node.data.indexOf(text);if(start>=0){const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+text.length);getSelection().removeAllRanges();getSelection().addRange(range);rpApp.scheduleSelection();return;}}
        throw new Error('Text not found in source message');
    },{index,text});
    try { await page.locator('.rp-action button').filter({hasText:/^标记$/}).waitFor({state:'visible',timeout:5000}); }
    catch(e){console.log(JSON.stringify(await page.evaluate(()=>({enabled:rpApp.enabled,selection:getSelection()?.toString(),anchor:getSelection()?.anchorNode?.parentElement?.outerHTML?.slice(0,700),action:rpApp.ui.action.outerHTML,dialog:rpApp.ui.dialog.open,inspect:rpApp.ui.inspect.open,key:rpApp.key(),library:rpApp.library?.records.length,toast:rpApp.ui.toast.innerText})),null,2));throw e;}
    await page.locator('.rp-action button').filter({hasText:/^标记$/}).click();
    await page.waitForFunction(text=>rpApp.library?.records.some(r=>r.text===text),text);
}
async function generate(type,provider='custom'){
    await page.evaluate(async({type,provider,mockURL})=>{
        const core=await import('/script.js'),ctx=SillyTavern.getContext();
        core.changeMainAPI('openai');
        Object.assign(ctx.chatCompletionSettings,{chat_completion_source:provider,custom_url:mockURL+'/v1',custom_model:'red-pen-mock',google_model:'gemini-2.0-flash',stream_openai:false,openai_max_context:16000,openai_max_tokens:128,reverse_proxy:provider==='makersuite'?mockURL:'',proxy_password:''});
        if(provider==='makersuite'){
            const{getStringHash}=await import('/scripts/utils.js');
            ctx.accountStorage.setItem(`Proxy_SkipConfirm_${getStringHash(mockURL)}`,'true');
        }
        core.setOnlineStatus('Valid');
        if(type==='normal')document.querySelector('#send_textarea').value='继续整理设定，标记仅作为材料。';
        await ctx.generate(type);
    },{type,provider,mockURL});
}
try{
    await page.goto(url,{waitUntil:'domcontentloaded'});await ready();
    const version=await page.evaluate(async()=>await(await fetch('/version')).json());assert.equal(version.pkgVersion,'1.18.0');
    await record('1.18 原生魔术棒加载 0.1.2，统一面板可开启暂停且无悬浮条',async()=>{
        assert.equal(await page.locator('#red-pen-menu-item').count(),1);assert.equal(await page.locator('#red-pen-bar').count(),0);
        await page.locator('#extensionsMenuButton').click();await page.locator('#red-pen-menu-item').click();
        const panel=page.getByRole('dialog',{name:'红笔标记控制面板'});
        await panel.getByRole('button',{name:'开启标记',exact:true}).click();await page.waitForFunction(()=>rpApp.enabled);
        await panel.getByRole('button',{name:'暂停标记',exact:true}).click();await page.waitForFunction(()=>!rpApp.enabled);
        assert.ok(await panel.locator('button').evaluateAll(buttons=>buttons.every(b=>b.getBoundingClientRect().height<=60)));
        await panel.getByRole('button',{name:'关闭',exact:true}).click();
        return{version:version.pkgVersion,commit:version.gitRevision,pluginVersion:await page.evaluate(async()=>await(await fetch('/scripts/extensions/third-party/red-pen/manifest.json')).json()).then(x=>x.version)};
    });
    const testAvatar=await page.evaluate(async()=>{
        const ctx=SillyTavern.getContext(),form=new FormData();
        form.set('ch_name','红笔118验收 '+Date.now());form.set('first_mes','旧设定：雨城。第二处细节：灯塔。');form.set('description','隔离测试角色，没有真实用户数据。');
        const headers=ctx.getRequestHeaders();delete headers['Content-Type'];
        const response=await fetch('/api/characters/create',{method:'POST',headers,body:form});if(!response.ok)throw new Error('Character creation failed');
        const avatar=await response.text();await ctx.getCharacters();const current=SillyTavern.getContext();
        await current.selectCharacterById(current.characters.findIndex(c=>c.avatar===avatar));await rpApp.refresh();
        window.parentChatId=SillyTavern.getContext().chatId;window.parentIntegrity=SillyTavern.getContext().chatMetadata.integrity;
        await rpApp.setEnabled(true);
        return avatar;
    });
    await record('真实消息选区、保存确认、高亮和原文保护',async()=>{
        const before=await page.evaluate(()=>SillyTavern.getContext().chat[0].mes);await mark(0,'雨城');
        assert.equal(await page.evaluate(()=>SillyTavern.getContext().chat[0].mes),before);
        assert.equal(await page.evaluate(()=>rpApp.painter.entries.length),1);return{};
    });
    for(const type of ['normal','regenerate','continue','swipe'])await record('原生 '+type+' → OpenAI 兼容最终 HTTP 请求完整附加一次',async()=>{
        const before=mockRequests.length;await generate(type);assert.equal(mockRequests.length,before+1);
        const texts=mockRequests.at(-1).body.messages.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
        assert.equal((texts.match(/"text": "雨城"/g)??[]).length,1);
        assert.equal(wire.at(-1).type,type);return{type,provider:'custom',markedText:'雨城'};
    });
    await record('原生 Google 请求 → 服务端 contents/parts 转换后完整附加一次',async()=>{
        const before=mockRequests.length;await generate('normal','makersuite');assert.equal(mockRequests.length,before+1);
        const body=mockRequests.at(-1).body;assert.ok(Array.isArray(body.contents));
        const texts=body.contents.flatMap(m=>m.parts??[]).map(p=>p.text??'').join('\n');
        assert.equal((texts.match(/"text": "雨城"/g)??[]).length,1);
        return{provider:'makersuite',format:'contents/parts',markedText:'雨城'};
    });
    await record('1.18 原生分支继承范围、父子独立、重命名与服务器保存 scope',async()=>{
        const lastIndex=await page.evaluate(()=>SillyTavern.getContext().chat.length-1);await mark(lastIndex,'本地模拟回复');
        const result=await page.evaluate(async()=>{
            const parentKey=rpApp.key(),before=rpApp.library.records.length;
            const{branchChat}=await import('/scripts/bookmarks.js');await branchChat(0);await rpApp.refresh();
            const ctx=SillyTavern.getContext(),key=rpApp.key(),scope=ctx.chatMetadata.red_pen_scope_v1;
            const inherited=rpApp.library.records.map(r=>r.text);const branchId=ctx.chatId;
            await rpApp.remove(rpApp.library.records.map(r=>r.id));
            await ctx.renameChat(branchId,branchId+' 改名');await rpApp.refresh();const renamed=rpApp.key()===key;
            const saved=await fetch('/api/chats/get',{method:'POST',headers:SillyTavern.getContext().getRequestHeaders(),body:JSON.stringify({avatar_url:SillyTavern.getContext().characters[SillyTavern.getContext().characterId].avatar,file_name:SillyTavern.getContext().chatId})}).then(r=>r.json());
            const persisted=saved[0]?.chat_metadata?.red_pen_scope_v1===scope;
            const sameNativeIntegrity=SillyTavern.getContext().chatMetadata.integrity===parentIntegrity;
            await SillyTavern.getContext().openCharacterChat(parentChatId);await rpApp.refresh();
            return{before,inherited,separate:key!==parentKey,renamed,persisted,sameNativeIntegrity,parentCount:rpApp.library.records.length};
        });
        assert.deepEqual(result.inherited,['雨城']);assert.equal(result.separate,true);assert.equal(result.renamed,true);assert.equal(result.persisted,true);assert.equal(result.sameNativeIntegrity,true);assert.equal(result.parentCount,result.before);return result;
    });
    await record('真实页面刷新恢复内容库、开关与正文高亮',async()=>{
        await page.reload({waitUntil:'domcontentloaded'});await ready();
        await page.evaluate(async avatar=>{const ctx=SillyTavern.getContext();await ctx.selectCharacterById(ctx.characters.findIndex(c=>c.avatar===avatar));await rpApp.refresh();},testAvatar);
        assert.equal(await page.evaluate(()=>rpApp.library?.records.length),2);assert.equal(await page.evaluate(()=>rpApp.enabled),true);assert.ok(await page.evaluate(()=>rpApp.painter.entries.length>=1));return{};
    });
    await record('关闭后原生请求零附加',async()=>{
        await page.evaluate(()=>rpApp.setEnabled(false));await generate('normal');
        const text=JSON.stringify(mockRequests.at(-1).body.messages);assert.ok(!text.includes('这些片段由用户手动标记'));return{};
    });
    // Native first-run AI Horde status checks can fail on this isolated network;
    // keep those unrelated errors separate from plugin exceptions.
    const pluginErrors=errors.filter(e=>!/Unexpected token 'I'.*Internal S/.test(e));
    assert.deepEqual(pluginErrors,[]);
    await mkdir(resolve(root,'docs/evidence'),{recursive:true});
    await page.evaluate(()=>rpApp.ui.open());
    await page.screenshot({path:resolve(root,'docs/evidence/runtime-1.18.png')});
    await page.getByRole('dialog',{name:'当前聊天标记库'}).getByRole('button',{name:'关闭',exact:true}).click();
    await record('真实 1.18 手机竖屏魔术棒入口与控制面板可操作',async()=>{
        await page.setViewportSize({width:393,height:851});
        await page.locator('#extensionsMenuButton').click();await page.locator('#red-pen-menu-item').scrollIntoViewIfNeeded();
        await page.screenshot({path:resolve(root,'docs/evidence/wand-menu-1.18-mobile.png')});
        await page.locator('#red-pen-menu-item').click();
        const panel=page.getByRole('dialog',{name:'红笔标记控制面板'});assert.ok((await panel.boundingBox()).width<=393);
        await page.screenshot({path:resolve(root,'docs/evidence/control-1.18-mobile.png')});
        await panel.getByRole('button',{name:'关闭',exact:true}).click();return{};
    });
    await record('核心模块加载失败仍保留原生魔术棒入口和持久错误说明',async()=>{
        const broken=await browser.newPage();
        await broken.route('**/scripts/extensions/third-party/red-pen/src/app.js',route=>route.abort());
        await broken.goto(url);
        await broken.waitForFunction(()=>document.querySelector('#red-pen-control details pre')?.textContent.includes('启动失败原因'),null,{timeout:60000});
        await broken.locator('#extensionsMenuButton').click();await broken.locator('#red-pen-menu-item').click();
        assert.match(await broken.getByRole('dialog',{name:'红笔标记控制面板'}).innerText(),/红笔尚未就绪/);
        await broken.close();return{};
    });
    await writeFile(resolve(root,'docs/evidence/runtime-1.18.json'),JSON.stringify({environment:'真实隔离 SillyTavern 1.18.0 + 本地 OpenAI/Google 模拟接口；未连接真实模型服务',version:version.pkgVersion,sourceCommit:'51ad27fb86d39a3daca3adaa970375c9670c12df',browser:browser.version(),at:new Date().toISOString(),results,unrelatedStartupErrors:errors,requests:mockRequests.map((r,i)=>({provider:r.body.contents?'Google contents/parts':'OpenAI messages',index:i+1,hasMarkedMaterial:JSON.stringify(r.body).includes('这些片段由用户手动标记')}))},null,2)+'\n');
    console.log('Real SillyTavern 1.18 checks passed:',results.length);
}finally{await browser.close();await new Promise(r=>mock.close(r));}
