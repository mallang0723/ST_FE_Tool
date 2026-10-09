import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base=process.argv[2]||'http://127.0.0.1:18019';const checks=[];
try{
    await page.goto(base);await page.waitForFunction(()=>window.SillyTavern?.getContext().characters.length>0);
    await page.evaluate(async name=>{const s=await import('/script.js');await s.selectCharacterById(0);const c=window.SillyTavern.getContext();await c.openCharacterChat(name);c.chat.splice(0,c.chat.length,...Array.from({length:65},(_,i)=>({name:i%2?'나':'Seraphina',is_user:Boolean(i%2),is_system:false,mes:'메시지 '+i+' 한글 본문',swipes:['메시지 '+i+' 한글 본문'],swipe_id:0,extra:{fixture:true},send_date:new Date().toISOString()})));await c.saveChat();await c.reloadCurrentChat();},'damso-ui-'+randomUUID());
    assert.equal(await page.evaluate(()=>window.SillyTavern.getContext().chat.length),65);checks.push('65 messages remain in memory after native reload');
    await page.locator('#extensionsMenuButton').click();await page.locator('#bai_bai_toolkit_floor_directory_button').click();
    assert.equal(await page.locator('.bai-bai-floor-row').count(),30);checks.push('message manager pages at 30');
    await page.locator('.bai-bai-floor-input').fill('메시지 30 한글');await page.waitForTimeout(350);assert.equal(await page.locator('.bai-bai-floor-row').count(),1);
    await page.locator('.bai-bai-floor-num').click();await page.locator('.bai-bai-floor-row').getByRole('button',{name:/편집/}).click();
    await page.locator('.bai-bai-floor-editor').fill('취소할 변경');await page.locator('.bai-bai-floor-row').getByRole('button',{name:/취소/}).click();
    assert.equal(await page.evaluate(()=>window.SillyTavern.getContext().chat[30].mes),'메시지 30 한글 본문');checks.push('message edit cancel leaves original');
    await page.locator('.bai-bai-floor-row').getByRole('button',{name:/편집/}).click();await page.locator('.bai-bai-floor-editor').fill('저장한 한국어 편집');
    await page.locator('.bai-bai-floor-row').getByRole('button',{name:/저장/}).click();await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(()=>{const m=window.SillyTavern.getContext().chat[30];return [m.mes,m.swipes[m.swipe_id]];}),['저장한 한국어 편집','저장한 한국어 편집']);
    await page.locator('.bai-bai-floor-close:visible').click();await page.evaluate(()=>window.SillyTavern.getContext().reloadCurrentChat());
    assert.equal(await page.evaluate(()=>window.SillyTavern.getContext().chat[30].mes),'저장한 한국어 편집');checks.push('message edit and current swipe persist through reload');
    const recovery=await page.evaluate(async()=>{
        const checkbox=document.querySelector('#bai_bai_toolkit_chat_loss_mitigation_enabled');checkbox.checked=true;checkbox.dispatchEvent(new Event('input',{bubbles:true}));
        const c=window.SillyTavern.getContext();const target={avatar_url:c.characters[c.characterId].avatar,file_name:c.characters[c.characterId].chat};
        const r=await fetch('/api/chats/get',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify(target)});const original=await r.json();
        await fetch('/api/chats/save',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({...target,chat:original.slice(0,3)})});
        await c.reloadCurrentChat();const shorter=c.chat.length===2;
        await fetch('/api/chats/save',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({...target,chat:original})});await c.reloadCurrentChat();
        return{shorter,target};
    });assert.equal(recovery.shorter,true);checks.push('legitimate shorter disk chat is never restored over');
    await page.route('**/api/chats/get',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture read failure"}'}));
    await page.evaluate(()=>window.SillyTavern.getContext().reloadCurrentChat());
    assert.equal(await page.evaluate(()=>window.SillyTavern.getContext().chat.length),65);
    const protectedDisk=await page.evaluate(async target=>{const c=window.SillyTavern.getContext();return fetch('/api/plugins/st-ko-tools/v1/chats/get',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify(target)}).then(r=>r.json());},recovery.target);
    assert.equal(protectedDisk.data.chat.length,66);await page.unroute('**/api/chats/get');await page.evaluate(()=>window.SillyTavern.getContext().reloadCurrentChat());checks.push('failed reload restores visible snapshot without overwriting file');
    const themeResult=await page.evaluate(async()=>{
        const {power_user}=await import('/scripts/power-user.js');const previous=power_user.theme;
        const select=document.querySelector('#themes');const candidate=Array.from(select.options).find(x=>globalThis.damsoThemeNeedsHydration(x.value));
        if(!candidate)throw new Error('No lazy theme fixture available');
        select.value=candidate.value;select.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<60&&globalThis.damsoThemeNeedsHydration(candidate.value);i++)await new Promise(r=>setTimeout(r,50));
        const hydrated=!globalThis.damsoThemeNeedsHydration(candidate.value)&&power_user.theme===candidate.value;
        select.value=previous;select.dispatchEvent(new Event('change',{bubbles:true}));return hydrated;
    });assert.equal(themeResult,true);checks.push('lazy theme hydration uses native applyTheme');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({base,checks,pageErrors:errors},null,2));
}finally{await browser.close();}
