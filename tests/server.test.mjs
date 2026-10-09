import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import * as coordinator from '../integration/chat-coordinator.mjs';
import { getLibrary, putLibrary } from '../server/services/library.mjs';
import { Backups } from '../server/services/backups.mjs';
import { atomicJson, changeDocument, safeFile } from '../server/storage/documents.mjs';
import { JobManager } from '../server/jobs/manager.mjs';
import { init } from '../server/index.mjs';
import { getConfig } from '../server/services/config.mjs';

async function fixture(t) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'damso-test-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const makeUser=async handle=>{
        const user={profile:{handle},directories:{root:path.join(root,handle)}};
        for(const name of ['chats','groupChats','groups','characters','backups','themes','extensions']) {user.directories[name]=path.join(user.directories.root,name);await fs.mkdir(user.directories[name],{recursive:true});}
        return user;
    };
    const user=await makeUser('alice');const other=await makeUser('bob');
    const target={avatar_url:'test.png',file_name:'test',type:'normal',ch_name:'캐릭터'};
    const file=coordinator.chatPath(user,target);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,[{chat_metadata:{integrity:'fixture'}},{name:'나',is_user:true,mes:'안녕'}].map(x=>JSON.stringify(x)).join('\n'));
    let generated=0;let complete;
    const gate=new Promise(resolve=>{complete=resolve;});
    const host={version:'1.19.0',supported:true,root,coordinator,
        async generate(_user,body,signal){generated++;await Promise.race([gate,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))]);return {choices:[{message:{content:'반가워요',reasoning_content:'생각'},finish_reason:'stop'}]};},
        async save(_user,file,chat){await fs.writeFile(file,chat.map(x=>JSON.stringify(x)).join('\n'));},
        async request(kind,route,_user,body,query){if(kind==='tokenizers')return {token_count:body[0].content.length+3};return {kind,route,body,query};},
    };
    const request=()=>({clientRequestId:randomUUID(),target,expectedRevision:coordinator.fileRevision(file),generate:{chat_completion_source:'openai',model:'fixture',messages:[{role:'user',content:'안녕'}],n:1}});
    const manager=new JobManager(host);t.after(()=>manager.stop());
    return {root,user,other,target,file,host,manager,request,complete,get generated(){return generated;}};
}
async function settle(manager,user,id) {
    for(let i=0;i<100;i++){const job=await manager.get(user,id);if(['saved','canceled','conflict','failed','interrupted'].includes(job.status))return job;await new Promise(r=>setTimeout(r,5));}
    throw new Error('job did not settle');
}
test('library isolates users and rejects a concurrent stale revision without losing fields',async t=>{
    const f=await fixture(t);const body={expectedRevision:0,items:[{id:'x',identifier:'keep',content:'본문',unknown:{keep:true}}],groups:[]};
    const results=await Promise.allSettled([putLibrary(f.user,body),putLibrary(f.user,body)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
    assert.equal((await getLibrary(f.other)).items.length,0);assert.equal((await getLibrary(f.user)).items[0].unknown.keep,true);
});
test('first server config preserves existing Tab and backup preferences without importing unrelated data',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.user.directories.root,'settings.json'),JSON.stringify({extension_settings:{baiBaiToolkit:{chatKeyboardScanReductionEnabled:true,presetBackupKeepCount:40,presetBackupAutoCleanupEnabled:false,secretSentinel:'do-not-copy'}}}));
    const [a,b]=await Promise.all([getConfig(f.user),getConfig(f.user)]);assert.deepEqual(a,b);assert.equal(a.chatKeyboardScanReductionEnabled,true);assert.equal(a.backupKeepCount,40);assert.equal(a.backupAutoCleanupEnabled,false);assert.equal(a.secretSentinel,undefined);
    assert.equal((await getConfig(f.other)).chatKeyboardScanReductionEnabled,false);
});
test('path traversal and escaping symlinks are rejected',async t=>{
    const f=await fixture(t);await assert.rejects(safeFile(f.user.directories.root,'../bob/settings.json'));
    await fs.symlink(f.other.directories.root,path.join(f.user.directories.root,'escape'));await assert.rejects(safeFile(f.user.directories.root,'escape/secret.json'));
    assert.throws(()=>coordinator.chatPath(f.user,{avatar_url:'../bob.png',file_name:'x'}));
});
test('backup quota is global, excludes notes, and malformed metadata blocks pruning',async t=>{
    const f=await fixture(t);const b=new Backups();
    await changeDocument(f.user,'config',{},0,()=>({backupKeepCount:2}));
    const protectedBackup=await b.create(f.user,{name:'A',preset:{prompts:[{identifier:'id',extra:true}]}});
    await b.mutate(f.user,protectedBackup.fileName,{note:'보존'});
    for(const name of ['B','C','D'])await b.create(f.user,{name,preset:{}});
    const list=await b.list(f.user);assert.equal(list.items.length,3);assert.ok(list.items.some(x=>x.fileName===protectedBackup.fileName));
    assert.equal((await b.get(f.user,protectedBackup.fileName)).body.preset.prompts[0].extra,true);
    await fs.writeFile(path.join(await b.directory(f.user),'corrupt.json'),'{}');
    await assert.rejects(b.prune(f.user,1));assert.equal((await fs.readdir(await b.directory(f.user))).length,4);
});
test('idempotent jobs survive a client disconnect and save exactly one marked reply',async t=>{
    const f=await fixture(t);const request=f.request();
    const [a,b]=await Promise.all([f.manager.submit(f.user,request),f.manager.submit(f.user,request)]);
    assert.equal(a.id,b.id);f.complete();const result=await settle(f.manager,f.user,a.id);
    assert.equal(result.status,'saved');assert.equal(f.generated,1);
    const chat=await f.manager.readChat(f.file);assert.equal(chat.length,3);assert.equal(chat.at(-1).extra.damsoJobId,a.id);
    await assert.rejects(f.manager.get(f.other,a.id),{status:404});
    assert.equal((await f.manager.submit(f.user,request)).id,a.id);
});
test('a competing native write keeps its contents and stores the generated result as conflict',async t=>{
    const f=await fixture(t);const job=await f.manager.submit(f.user,f.request());
    await coordinator.withChatWrite(f.user,async()=>{const chat=await f.manager.readChat(f.file);chat[1].mes='다른 탭 수정';await f.host.save(f.user,f.file,chat);});
    f.complete();const result=await settle(f.manager,f.user,job.id);
    assert.equal(result.status,'conflict');assert.equal(result.result.content,'반가워요');assert.equal((await f.manager.readChat(f.file))[1].mes,'다른 탭 수정');
});
test('explicit cancel wins before commit; cancel after commit returns saved',async t=>{
    const f=await fixture(t);const job=await f.manager.submit(f.user,f.request());
    assert.equal((await f.manager.cancel(f.user,job.id)).status,'canceled');f.complete();await settle(f.manager,f.user,job.id);assert.equal((await f.manager.readChat(f.file)).length,2);
    const second=await f.manager.submit(f.user,f.request());await settle(f.manager,f.user,second.id);assert.equal((await f.manager.cancel(f.user,second.id)).status,'saved');
});
test('restart after chat save reconciles the marker without adding another answer',async t=>{
    const f=await fixture(t);const job=await f.manager.submit(f.user,f.request());f.complete();await settle(f.manager,f.user,job.id);
    const record=await f.manager.get(f.user,job.id);record.status='committing';
    await atomicJson(path.join(f.user.directories.root,'st-ko-tools/jobs.json'),{schemaVersion:1,revision:99,jobs:[record]});
    const restored=new JobManager(f.host);assert.equal((await restored.get(f.user,job.id)).status,'saved');assert.equal((await restored.readChat(f.file)).length,3);
});
test('interrupted requests never auto-retry and secrets are not persisted',async t=>{
    const f=await fixture(t);const request=f.request();request.generate.proxy_password='test-secret-sentinel';
    const job=await f.manager.submit(f.user,request);
    while (!f.generated) await new Promise(resolve => setTimeout(resolve, 2));
    await f.manager.stop();
    const restored=new JobManager(f.host);assert.equal((await restored.get(f.user,job.id)).status,'interrupted');assert.equal(f.generated,1);
    assert.ok(!(await fs.readFile(path.join(f.user.directories.root,'st-ko-tools/jobs.json'),'utf8')).includes('test-secret-sentinel'));
});
test('regenerate replaces the existing assistant reply and preserves chat metadata',async t=>{
    const f=await fixture(t);const chat=await f.manager.readChat(f.file);chat.push({is_user:false,mes:'이전 답변'});await f.host.save(f.user,f.file,chat);
    const body=f.request();body.target={...body.target,type:'regenerate'};const job=await f.manager.submit(f.user,body);f.complete();assert.equal((await settle(f.manager,f.user,job.id)).status,'saved');
    const result=await f.manager.readChat(f.file);assert.equal(result.length,3);assert.equal(result[0].chat_metadata.integrity,'fixture');assert.equal(result[2].mes,'반가워요');
});
test('API reports actual capability contracts and token batch preserves ids/order',async t=>{
    const f=await fixture(t);const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=f.user;next();});const router=express.Router();await init(router,{host:f.host});app.use('/api/plugins/st-ko-tools',router);
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
    const base='http://127.0.0.1:'+server.address().port+'/api/plugins/st-ko-tools/v1';
    const status=await fetch(base+'/status').then(r=>r.json());assert.equal(status.data.protocolVersion,1);assert.equal(status.data.capabilities.backgroundJobs,true);assert.equal(status.data.driver,undefined);
    const result=await fetch(base+'/tokenizers/bulk-count',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:'b',model:'mock',messages:[{content:'안녕'}]},{id:'a',model:'mock',messages:[{content:'hello'}]}]})}).then(r=>r.json());
    assert.deepEqual(result.data.counts,[{id:'b',count:5},{id:'a',count:8}]);
});
test('complete-response tool extracts content and rejects general tools or multiple candidates',async t=>{
    const f=await fixture(t);
    f.host.generate=async()=>({choices:[{message:{content:null,tool_calls:[{function:{name:'emit_complete_response',arguments:JSON.stringify({content:'완성된 답변'})}}]}}]});
    const body=f.request();body.generate.tools=[{type:'function',function:{name:'emit_complete_response',parameters:{type:'object',properties:{content:{type:'string'}},required:['content']}}}];
    const job=await f.manager.submit(f.user,body);assert.equal((await settle(f.manager,f.user,job.id)).status,'saved');assert.equal((await f.manager.readChat(f.file)).at(-1).mes,'완성된 답변');
    const general=f.request();general.generate.tools=[{type:'function',function:{name:'arbitrary_tool'}}];await assert.rejects(f.manager.submit(f.user,general),{status:400});
    const multiple=f.request();multiple.generate.n=2;await assert.rejects(f.manager.submit(f.user,multiple),{status:400});
});
test('native write lock survives client disconnect until the handler finishes, then releases',async t=>{
    const f=await fixture(t);const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=f.user;next();});const router=express.Router();coordinator.installChatCoordination(router);
    let started;const writing=new Promise(r=>{started=r;});let finish;const gate=new Promise(r=>{finish=r;});
    router.post('/save',async(req,res)=>{started();await gate;await fs.writeFile(f.file,'native-finished');res.send({ok:true});});app.use(router);
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
    const controller=new AbortController();const pending=fetch('http://127.0.0.1:'+server.address().port+'/save',{method:'POST',headers:{'content-type':'application/json','x-damso-revision':coordinator.fileRevision(f.file)},body:JSON.stringify(f.target),signal:controller.signal}).catch(()=>{});
    await writing;controller.abort();await pending;
    let entered=false;const next=coordinator.withChatWrite(f.user,async()=>{entered=true;assert.equal(await fs.readFile(f.file,'utf8'),'native-finished');});
    await new Promise(r=>setTimeout(r,20));assert.equal(entered,false);finish();await next;assert.equal(entered,true);
});
