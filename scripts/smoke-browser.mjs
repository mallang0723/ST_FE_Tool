import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs');
const base=process.argv[2] || 'http://127.0.0.1:18019';
const prefix='/api/plugins/st-ko-tools/v1';
let calls=0, slow=false, failOnce=false;
const provider=http.createServer((req,res)=>{
    req.resume();calls++;res.setHeader('Content-Type','application/json');
    if(failOnce){failOnce=false;res.statusCode=503;res.end(JSON.stringify({error:{message:'fixture transient error'}}));return;}
    const result='한국어 브라우저 검증 답변 '+calls;
    setTimeout(()=>res.end(JSON.stringify({id:'browser-fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:result},finish_reason:'stop'}]})),slow?2000:100);
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const errors=[];let page;const checks=[];
const chatName='damso-browser-'+randomUUID();
async function open(){page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>window.SillyTavern?.getContext().characters.length>0);}
async function prepare(){await page.evaluate(async({url,chatName})=>{
    const s=await import('/script.js');const o=await import('/scripts/openai.js');
    await s.selectCharacterById(0);await window.SillyTavern.getContext().openCharacterChat(chatName);
    o.oai_settings.chat_completion_source='custom';o.oai_settings.custom_url=url;o.oai_settings.custom_model='fixture';o.oai_settings.stream_openai=true;s.setOnlineStatus('valid');
    const retry=document.querySelector('#bai_bai_toolkit_generate_retry_enabled');retry.checked=true;retry.dispatchEvent(new Event('input',{bubbles:true}));
},{url:'http://127.0.0.1:'+provider.address().port,chatName});}
async function api(route,body){return page.evaluate(async({route,body})=>{const s=await import('/script.js');const r=await fetch(route,{method:body?'POST':'GET',headers:s.getRequestHeaders(),...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw new Error('HTTP '+r.status);return r.json();},{route,body});}
async function generate(type='normal'){return page.evaluate(async type=>{if(type==='normal')document.querySelector('#send_textarea').value='한국어 저장 확인';await window.SillyTavern.getContext().generate(type);await window.SillyTavern.getContext().saveChat();return window.SillyTavern.getContext().chat.map(m=>({mes:m.mes,is_user:m.is_user}));},type);}
try {
    await open();await prepare();
    const target={avatar_url:'default_Seraphina.png',file_name:chatName};
    const before=calls;let chat=await generate();assert.equal(calls,before+1);assert.match(chat.at(-1).mes,/한국어 브라우저/);
    let disk=(await api(prefix+'/chats/get',target)).data;assert.ok(disk.chat.at(-1).extra.damsoJobId);assert.equal(disk.chat.filter(m=>m.mes===chat.at(-1).mes).length,1);checks.push('native UI generation through background job; one saved reply');
    const length=chat.length;chat=await generate('regenerate');assert.equal(chat.length,length);assert.equal(calls,before+2);checks.push('regenerate replaces one reply');
    failOnce=true;const retryCalls=calls;chat=await generate();assert.equal(calls,retryCalls+2);assert.match(chat.at(-1).mes,/한국어 브라우저/);checks.push('confirmed transient failure retries once');
    slow=true;
    const accepted=page.waitForResponse(r=>r.url()===base+prefix+'/jobs'&&r.request().method()==='POST');
    await page.evaluate(()=>{document.querySelector('#send_textarea').value='닫은 뒤에도 저장';void window.SillyTavern.getContext().generate('normal').catch(()=>{});});
    const job=(await (await accepted).json()).data;
    await page.close();await new Promise(r=>setTimeout(r,2600));await open();await prepare();
    const saved=(await api(prefix+'/jobs/'+job.id)).data;assert.equal(saved.status,'saved');
    disk=(await api(prefix+'/chats/get',target)).data;assert.equal(disk.chat.filter(m=>m.extra?.damsoJobId===job.id).length,1);checks.push('browser close, server save and reconnect');
    const canceledResponse=page.waitForResponse(r=>r.url()===base+prefix+'/jobs'&&r.request().method()==='POST');
    await page.evaluate(()=>{document.querySelector('#send_textarea').value='중단 확인';void window.SillyTavern.getContext().generate('normal').catch(()=>{});});
    const cancelJob=(await (await canceledResponse).json()).data;
    await page.evaluate(()=>window.SillyTavern.getContext().stopGeneration());await page.waitForTimeout(2300);
    assert.equal((await api(prefix+'/jobs/'+cancelJob.id)).data.status,'canceled');checks.push('native stop cancels server job');
    await page.locator('#extensions-settings-button .drawer-toggle').click();
    await page.locator('.bai_bai_toolkit_settings .inline-drawer-toggle').click();
    await page.locator('[data-target="bai_bai_toolkit_tab_baibaoku"]').click();
    assert.match(await page.locator('#bai_bai_toolkit_baibaoku_server_status').innerText(),/연결됨/);
    assert.equal(await page.locator('#bai_bai_toolkit_progressive_chat_loading_enabled').isDisabled(),true);
    await fs.mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/desktop.png'});checks.push('Korean settings and live capabilities');
    await page.locator('#damso-jobs-button').click();await page.waitForTimeout(200);
    assert.ok(await page.getByRole('heading',{name:'백그라운드 작업 기록',exact:true}).count());
    await page.getByRole('button',{name:'닫기',exact:true}).click();checks.push('job history dialog');
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
    await page.screenshot({path:'test-results/mobile.png'});
    const bounds=await page.locator('.bai_bai_toolkit_settings').boundingBox();assert.ok(bounds.width<=390);checks.push('390px mobile settings layout');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({base,checks,pageErrors:errors,provider:'local mock only'},null,2));
} finally {await browser.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
