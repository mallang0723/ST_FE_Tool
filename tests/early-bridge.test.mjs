import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../integration/early-bridge.js',import.meta.url),'utf8');
function fixture(config={}){
    const calls=[];let fail=false;
    const context=vm.createContext({URL,Request,Response,Headers,AbortSignal,Map,Date,location:{href:'http://fixture/',origin:'http://fixture'},fetch:async(input,init)=>{
        const pathname=new URL(input,'http://fixture').pathname;calls.push({pathname,init});
        if(pathname.endsWith('/config'))return Response.json({ok:true,data:config});
        if(pathname.endsWith('/get')&&fail)throw new Error('network disconnected');
        return Response.json([],{headers:{'x-damso-revision':'revision-1'}});
    }});vm.runInContext(source,context);
    return{context,calls,fail(value){fail=value;}};
}
test('early bridge sends native revision, blocks writes after read failure and recovers on a successful read',async()=>{
    const f=fixture();const body=JSON.stringify({avatar_url:'x.png',file_name:'chat'});
    await f.context.fetch('/api/chats/get',{method:'POST',body});
    await f.context.fetch('/api/chats/save',{method:'POST',body});
    assert.equal(f.calls.at(-1).init.headers.get('x-damso-revision'),'revision-1');
    f.fail(true);await assert.rejects(f.context.fetch('/api/chats/get',{method:'POST',body}));
    const count=f.calls.length;assert.equal((await f.context.fetch('/api/chats/save',{method:'POST',body})).status,409);assert.equal(f.calls.length,count);
    f.fail(false);await f.context.fetch('/api/chats/get',{method:'POST',body});assert.equal((await f.context.fetch('/api/chats/save',{method:'POST',body})).status,200);
});
test('failed chat read does not block another chat or unrelated fetch',async()=>{
    const f=fixture();f.fail(true);await assert.rejects(f.context.fetch('/api/chats/get',{body:JSON.stringify({avatar_url:'x.png',file_name:'a'})}));
    assert.equal((await f.context.fetch('/api/chats/save',{body:JSON.stringify({avatar_url:'x.png',file_name:'b'})})).status,200);
    assert.equal((await f.context.fetch('http://external.example/thing')).status,200);
});
test('disabled or missing user extension keeps native bootstrap; enabled extension accelerates first settings request',async()=>{
    const disabled=fixture({uiEnabled:false,settingsAccelerationEnabled:true,lazyThemeLoadingEnabled:true});
    await disabled.context.fetch('/api/settings/get',{method:'POST',body:'{}'});assert.equal(disabled.calls.at(-1).pathname,'/api/settings/get');
    const enabled=fixture({uiEnabled:true,settingsAccelerationEnabled:true});
    await enabled.context.fetch('/api/settings/get',{method:'POST',body:'{}'});assert.equal(enabled.calls.at(-1).pathname,'/api/plugins/st-ko-tools/v1/bootstrap/settings');
});
