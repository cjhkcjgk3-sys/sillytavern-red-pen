import test from 'node:test';
import assert from 'node:assert/strict';
import { chatIdentity, needsSeparateScope, SCOPE } from '../src/compat.js';
import { newLibrary } from '../src/core.js';
import { Transport } from '../src/transport.js';

function context(chatId = '父聊天', metadata = { integrity: 'shared-native-integrity' }) {
    return { chatId, chatMetadata: metadata, characters: [{ avatar: 'role.png' }], characterId: 0, groupId: null };
}
test('1.18 父子完整性标识相同，插件 scope 分开库且不改原完整性标识', () => {
    const parent = context(), child = context('分支', { integrity: parent.chatMetadata.integrity, main_chat: parent.chatId });
    const original = chatIdentity(parent,'user');
    const lib = { ...newLibrary(original.key,original.owner,parent.chatId), branchParent:null };
    assert.equal(needsSeparateScope(child,chatIdentity(child,'user'),lib),true);
    child.chatMetadata[SCOPE]='child-scope';
    assert.notEqual(chatIdentity(child,'user').key,original.key);
    assert.equal(child.chatMetadata.integrity,parent.chatMetadata.integrity);
    assert.equal(chatIdentity(parent,'user').key,original.key);
});
test('预先存在的 1.18 分支和分支再分支，均建立独立库；重命名不换库', () => {
    const child=context('分支',{integrity:'same',main_chat:'父聊天'});
    assert.equal(needsSeparateScope(child,chatIdentity(child,'user'),null),true);
    child.chatMetadata[SCOPE]='child';
    const identity=chatIdentity(child,'user'),lib={...newLibrary(identity.key,identity.owner,'分支'),branchParent:'父聊天'};
    child.chatId='已重命名分支';
    assert.equal(needsSeparateScope(child,chatIdentity(child,'user'),lib),false);
    assert.equal(chatIdentity(child,'user').key,identity.key);
    const grandchild=context('孙分支',{...child.chatMetadata,main_chat:child.chatId});
    assert.equal(needsSeparateScope(grandchild,chatIdentity(grandchild,'user'),lib),true);
});
test('0.1.0 普通库和已有 1.19 分支保留原 key；账号、角色、群组仍隔离', () => {
    const original=context(),identity=chatIdentity(original,'user');
    const lib=newLibrary(identity.key,identity.owner,original.chatId);
    assert.equal(needsSeparateScope(original,identity,lib),false);
    const child=context('重命名分支',{integrity:'different',main_chat:'父聊天'});
    const childId=chatIdentity(child,'user');
    assert.equal(needsSeparateScope(child,childId,{...newLibrary(childId.key,childId.owner,'旧分支名'),inheritedFrom:identity.key}),false);
    assert.notEqual(chatIdentity(original,'other-user').key,identity.key);
    assert.notEqual(chatIdentity({...original,groupId:'group-1'},'user').key,identity.key);
    assert.throws(()=>chatIdentity(context('坏数据',{integrity:'same',[SCOPE]:{bad:true}}),'user'),/标识无效/);
});
test('等待 1.18 隔离准备完成后读取最终库，准备期间切换聊天则阻止附加', async () => {
    const ctx=context(),loaded=[];let key='unscoped-parent';
    const transport=new Transport({host:()=>ctx,currentKey:()=>key,enabled:()=>true,load:async key=>{loaded.push(key);return{records:[]};},ready:async()=>{key='persisted-child-scope';},report:()=>{},notify:()=>{}});
    await transport.start('normal',{},false);
    assert.deepEqual(loaded,['persisted-child-scope']);assert.equal(transport.snapshot.key,'persisted-child-scope');
    loaded.length=0;
    transport.ready=async()=>{ctx.chatId='other-chat';ctx.chatMetadata={integrity:'shared-native-integrity'};};
    await transport.start('normal',{},false);
    assert.deepEqual(loaded,[]);assert.match(transport.snapshot.error,/聊天发生切换/);
});
