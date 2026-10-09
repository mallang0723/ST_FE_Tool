import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
const base=process.argv[2] || 'http://127.0.0.1:18019';
const prefix='/api/plugins/st-ko-tools/v1';
const csrf=await fetch(base+'/csrf-token');
const cookie=csrf.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
const {token}=await csrf.json();
const headers={'Content-Type':'application/json','X-CSRF-Token':token,Cookie:cookie};
async function call(route,body,method=body===undefined?'GET':'POST',extra={}) {
    const response=await fetch(base+route,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw new Error(route+' returned non-JSON HTTP '+response.status);}
    if(!response.ok)throw Object.assign(new Error(route+' HTTP '+response.status),{status:response.status,data});
    return {data,revision:response.headers.get('x-damso-revision')};
}
const status=(await call(prefix+'/status')).data.data;
assert.equal(status.protocolVersion,1);assert.equal(status.host.supported,true);
const nativeSettings=(await call('/api/settings/get',{})).data;
const fastSettings=(await call(prefix+'/bootstrap/settings',{})).data;
assert.deepEqual(Object.keys(fastSettings).sort(),Object.keys(nativeSettings).sort());
assert.deepEqual(fastSettings.themes.map(t=>t.name),nativeSettings.themes.map(t=>t.name));
for(const theme of fastSettings.themes.filter(x=>x.damsoLazy).slice(0,1)) {
    const full=(await call(prefix+'/themes/get',{name:theme.name})).data.data;
    assert.deepEqual(full,nativeSettings.themes.find(t=>t.name===theme.name));
}
const bundle=(await call(prefix+'/extensions/bundle')).data.data;
assert.deepEqual(bundle.entries,(await call('/api/extensions/discover')).data);
assert.ok(bundle.manifests['third-party/damso-tools']);
const messages=[{role:'user',content:'한국어 테스트 Hello'}];
const normalCount=(await call('/api/tokenizers/openai/count?model=gpt-3.5-turbo',messages)).data.token_count;
const bulk=(await call(prefix+'/tokenizers/bulk-count',{items:[{id:'한국어',model:'gpt-3.5-turbo',messages}]})).data.data;
assert.deepEqual(bulk.counts,[{id:'한국어',count:normalCount}]);
const originalLibrary=(await call(prefix+'/prompt-library')).data.data;
const changed=(await call(prefix+'/prompt-library',{expectedRevision:originalLibrary.revision,items:[{id:'smoke',content:'본문',identifier:'preserved'}],groups:[]},'PUT')).data.data;
await assert.rejects(call(prefix+'/prompt-library',{expectedRevision:originalLibrary.revision,items:[],groups:[]},'PUT'),{status:409});
await call(prefix+'/prompt-library',{...originalLibrary,expectedRevision:changed.revision},'PUT');
const backup=(await call(prefix+'/preset-backups',{name:'개발 확인',apiId:'openai',preset:{prompts:[{identifier:'stable',content:'본문'}],extensions:{baibaiToolkit:{presetPromptGroups:[]}}}})).data.data;
await call(prefix+'/preset-backups/note',{fileName:backup.fileName,note:'보존 확인'});
const restored=(await call(prefix+'/preset-backups/get',{fileName:backup.fileName})).data.data;
assert.equal(restored.body.preset.prompts[0].identifier,'stable');assert.equal(restored.note,'보존 확인');
await call(prefix+'/preset-backups/delete',{fileName:backup.fileName});
const chatTarget={avatar_url:'default_Seraphina.png',file_name:'damso-smoke-'+randomUUID(),ch_name:'Seraphina',type:'normal'};
await call('/api/chats/get',chatTarget);
const chat=[{user_name:'개발 확인',character_name:'Seraphina',create_date:new Date().toISOString(),chat_metadata:{integrity:randomUUID()}},{name:'개발 확인',is_user:true,mes:'안녕',send_date:new Date().toISOString()}];
const save=await call('/api/chats/save',{...chatTarget,chat});assert.ok(save.revision);
const nativeSearch=(await call('/api/chats/search',{avatar_url:chatTarget.avatar_url,query:chatTarget.file_name})).data;
assert.deepEqual((await call(prefix+'/chats/search',{avatar_url:chatTarget.avatar_url,query:chatTarget.file_name})).data,nativeSearch);
let calls=0;
const provider=http.createServer((req,res)=>{req.resume();calls++;setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'모의 공급자 답변',reasoning_content:'확인'},finish_reason:'stop'}]}));},200);});
await new Promise(r=>provider.listen(0,process.env.DAMSO_FIXTURE_BIND || '127.0.0.1',r));
try {
    const body={clientRequestId:randomUUID(),target:chatTarget,expectedRevision:save.revision,generate:{chat_completion_source:'custom',custom_url:'http://'+(process.env.DAMSO_FIXTURE_HOST || '127.0.0.1')+':'+provider.address().port,model:'fixture',messages,stream:true,n:1,temperature:0.5}};
    const [a,b]=await Promise.all([call(prefix+'/jobs',body),call(prefix+'/jobs',body)]);
    assert.equal(a.data.data.id,b.data.data.id);const id=a.data.data.id;let job;
    for(let i=0;i<100;i++){job=(await call(prefix+'/jobs/'+id)).data.data;if(['saved','failed','conflict'].includes(job.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(job.status,'saved',JSON.stringify(job.error));assert.equal(calls,1);
    const disk=(await call('/api/chats/get',chatTarget));assert.equal(disk.data.at(-1).extra.damsoJobId,id);assert.equal(disk.data.at(-1).mes,'모의 공급자 답변');
    await assert.rejects(call('/api/chats/save',{...chatTarget,chat},'POST',{'x-damso-revision':save.revision}),{status:409});
    await assert.rejects(call('/api/chats/save',{...chatTarget,chat}),{status:428});
    assert.equal((await call(prefix+'/jobs/'+id+'/cancel',{})).data.data.status,'saved');
    await call('/api/chats/delete',{...chatTarget,chatfile:chatTarget.file_name+'.jsonl'},'POST',{'x-damso-revision':disk.revision});
} finally {await new Promise(r=>provider.close(r));}
const unauthenticated=await fetch(base+prefix+'/prompt-library',{method:'PUT',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'});
assert.equal(unauthenticated.status,403,'Native CSRF protection must remain enabled');
console.log(JSON.stringify({host:status.host.version,checks:['status','native settings shape','lazy theme hydration','manifest order','native tokenizer equality','library revision','backup roundtrip','chat search','native generation handler with local mock provider','idempotency','durable save marker','stale native save rejection','cancel-after-save','CSRF'],provider:'local mock; no real model credentials used'},null,2));
