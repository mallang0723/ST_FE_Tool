import { eventSource, event_types, getRequestHeaders } from '@sillytavern/script';
import { getContext } from '@sillytavern/scripts/extensions';
import { settings, extensionState } from './state.js';
import { getGenerationRequestId, getCompleteResponseToolName, markGenerationRequest, stripGenerationRequestId } from './generateRequest.js';
import { getGenerationStopEpoch, isCurrentGenerationStopped } from './generationLifecycle.js';
import { consumeGenerateRetryAttempt, getGenerateRetryMaxRetries } from './generateRetry.js';
import { API } from '../backend/client.js';
import { CURRENT_VERSION } from './constants.js';

const terminal = new Set(['saved','conflict','failed','canceled','interrupted']);
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const state = { installed:false, intent:null, active:null, pendingSaves:new Map(), status:null };
const targetKey = target => target.avatar_url + ':' + target.file_name;
function target(type) {
    const c = getContext();
    const ch = c.characters?.[c.characterId];
    if (c.groupId || !ch?.avatar || !ch?.chat) return null;
    return { avatar_url:ch.avatar, file_name:ch.chat, ch_name:ch.name, chatId:c.getCurrentChatId?.() || ch.chat, type };
}
export function markSaveGenerateBackendAvailable(_state, available, status) { state.status = available ? status : null; }
async function call(path, init = {}) {
    const response = await state.original(API + path, { ...init, headers:getRequestHeaders() });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error?.message || '백그라운드 작업 요청에 실패했습니다.');
        error.status = response.status; throw error;
    }
    return payload.data;
}
async function recover() {
    if (state.active) return;
    const selected = target('normal');
    if (!selected) return;
    try {
        const jobs = await call('/jobs');
        const relevant = jobs.filter(j => targetKey(j.target) === targetKey(selected)).sort((a,b) => b.createdAt-a.createdAt);
        const active = relevant.find(j => !terminal.has(j.status));
        if (active) {
            globalThis.toastr?.info('서버에서 답변을 생성 중입니다. 결과가 저장되면 다시 불러옵니다.', '담소 도구함');
            void watchRecovered(active, selected);
        } else if (relevant[0]?.status === 'saved') {
            const disk = await call('/chats/get', { method:'POST',body:JSON.stringify(selected) });
            const id = relevant[0].id;
            if (disk.chat.some(m=>m.extra?.damsoJobId===id) && !getContext().chat.some(m=>m.extra?.damsoJobId===id)) {
                await getContext().reloadCurrentChat();
            }
        }
    } catch {}
}
async function watchRecovered(job, selected) {
    while (!terminal.has(job.status) && targetKey(target('normal') || {}) === targetKey(selected)) {
        await delay(1500);
        try { job = await call('/jobs/' + job.id); } catch { return; }
    }
    if (job.status === 'saved' && targetKey(target('normal') || {}) === targetKey(selected)) await getContext().reloadCurrentChat();
    else if (job.status === 'conflict') globalThis.toastr?.warning('다른 창에서 채팅이 변경되어 답변을 작업 기록에 보관했습니다.', '담소 도구함');
}
async function cancel() {
    const active = state.active;
    if (!active) return;
    active.canceled = true;
    try {
        let job = active.job;
        if (!job) job = await call('/jobs/' + encodeURIComponent(active.requestId));
        active.job = await call('/jobs/' + job.id + '/cancel', { method:'POST',body:'{}' });
    } catch { globalThis.toastr?.warning('중단 상태를 확인하지 못했습니다. 작업 기록에서 확인해 주세요.', '담소 도구함'); }
}
function resultResponse(job, stream) {
    const source = job.result.response;
    if (!stream) return new Response(JSON.stringify(source), { status:200,headers:{'Content-Type':'application/json'} });
    const choice = source.choices[0];
    const delta = { ...(choice.message || {}), content: job.result.content };
    const chunks = [
        { ...source, choices:[{ index:0, delta, finish_reason:null }] },
        { choices:[{ index:0, delta:{}, finish_reason:choice.finish_reason || 'stop' }] },
    ];
    return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n', { status:200,headers:{'Content-Type':'text/event-stream'} });
}
async function generate(body, selected, signal) {
    const bridge = globalThis.__damsoEarlyBridge;
    if (!bridge) throw new Error('초기 연결이 필요합니다.');
    const epoch = getGenerationStopEpoch();
    const run = extensionState.generateBlacklistRetry?.run;
    const budget = run?.phase === 'generating' ? run : { retries:0,maxRetries:getGenerateRetryMaxRetries() };
    // Persist the user message/native regenerate deletion before taking the revision.
    await getContext().saveChat();
    const snapshot = await call('/chats/get', { method:'POST',body:JSON.stringify(selected) });
    const visible=getContext().chat;
    if(targetKey(target(selected.type)||{})!==targetKey(selected))throw new DOMException('채팅 전환됨','AbortError');
    if(snapshot.chat.length!==visible.length+1 || visible.some((message,index)=>message.mes!==snapshot.chat[index+1]?.mes || Boolean(message.is_user)!==Boolean(snapshot.chat[index+1]?.is_user))) {
        throw new Error('현재 채팅을 저장하지 못했습니다. 다른 창의 변경을 확인하고 다시 불러온 뒤 생성하세요.');
    }
    let attempt = run?.damsoNextAttempt || 0;
    const runId = run ? (run.damsoRunId ||= crypto.randomUUID()) : crypto.randomUUID();
    while (true) {
        if (signal?.aborted || epoch !== getGenerationStopEpoch()) throw new DOMException('중단됨','AbortError');
        const requestId = crypto.randomUUID();
        const active = state.active = { requestId,job:null,canceled:false };
        const requestBody = { clientRequestId:requestId,runId,attempt,expectedRevision:snapshot.revision,target:selected,generate:stripGenerationRequestId(body) };
        if(run)run.damsoNextAttempt=attempt+1;
        let job;
        try { job = await call('/jobs', { method:'POST',body:JSON.stringify(requestBody) }); }
        catch (error) {
            // Lost acceptance is uncertain: query the same ID; never dispatch a native fallback here.
            try { job = await call('/jobs/' + requestId); }
            catch { throw new Error('작업 접수 여부를 확인하지 못했습니다. 작업 기록을 확인한 뒤 다시 실행해 주세요.'); }
        }
        active.job = job;
        if (active.canceled || signal?.aborted || epoch !== getGenerationStopEpoch()) {
            job = await call('/jobs/' + job.id + '/cancel', { method:'POST',body:'{}' });
        }
        let errors = 0;
        while (!terminal.has(job.status)) {
            await delay(1000);
            try { job = await call('/jobs/' + job.id); errors = 0; }
            catch { if (++errors >= 10) throw new Error('작업 연결이 끊겼습니다. 서버 작업은 계속됩니다. 재접속 후 확인해 주세요.'); }
        }
        active.job = job;
        if (job.status === 'saved') {
            bridge.setRevision(selected,job.savedRevision);
            state.pendingSaves.set(targetKey(selected),job);
            return resultResponse(job,body.stream === true);
        }
        if (job.status === 'failed' && job.error?.retryable && settings.generateRetryEnabled && epoch === getGenerationStopEpoch() && budget.retries < budget.maxRetries) {
            await delay(Math.min(1500 * 2 ** budget.retries,15000));
            if (epoch !== getGenerationStopEpoch() || signal?.aborted || !consumeGenerateRetryAttempt(budget)) throw new DOMException('중단됨','AbortError');
            attempt++; continue;
        }
        if (job.status === 'canceled') throw new DOMException('중단됨','AbortError');
        throw new Error(job.status === 'conflict' ? '채팅 변경이 감지되어 자동 저장하지 않았습니다. 작업 기록에서 답변을 확인하세요.' : '작업을 완료하지 못했습니다. 작업 기록을 확인하세요.');
    }
}
export function installSaveGenerateFetchHook() {
    if (state.installed) return state;
    state.installed = true;
    const previous = globalThis.fetch;
    state.original = previous.bind(globalThis);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS,(type,options={},dryRun=false)=>{
        if (dryRun) return;
        state.intent = null;
        if (!settings.saveGenerateEnabled || !['normal','regenerate'].includes(type || 'normal') || options.quiet_prompt || options.quietToLoud || options.quietImage || options.quietName || options.force_chid != null || Number(options.depth || 0)>0 || isCurrentGenerationStopped()) return;
        const selected=target(type || 'normal');
        if(selected) state.intent={target:selected,requestId:''};
    });
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY,body=>{
        if (state.intent && (body.type || 'normal') === state.intent.target.type) state.intent.requestId=markGenerationRequest(body);
    });
    eventSource.on(event_types.GENERATION_STOPPED,()=>{ state.intent=null; void cancel(); });
    eventSource.on(event_types.GENERATION_ENDED,()=>{ state.intent=null; });
    eventSource.on(event_types.CHAT_CHANGED,()=>{ state.intent=null; void cancel(); void recover(); });
    eventSource.on(event_types.APP_READY,()=>{ void recover(); });
    const wrapped = async (input,init) => {
        const url = new URL(typeof input==='string' || input instanceof URL ? input : input.url,location.href);
        let body;
        if (typeof init?.body==='string') { try {body=JSON.parse(init.body);} catch{} }
        if(url.origin===location.origin && url.pathname==='/api/chats/save' && body){
            const job=state.pendingSaves.get(targetKey(body));
            if(job && Array.isArray(body.chat)){
                const reply=body.chat.at(-1);
                if(reply?.is_user===false && reply.mes===job.result.content){
                    reply.extra={...reply.extra,damsoJobId:job.id};
                    const visible=getContext().chat.at(-1);
                    if(visible?.is_user===false && visible.mes===reply.mes)visible.extra={...visible.extra,damsoJobId:job.id};
                    init={...init,body:JSON.stringify(body)};
                    state.pendingSaves.delete(targetKey(body));
                }
            }
        }
        const intent=state.intent;
        if(url.origin!==location.origin || url.pathname!=='/api/backends/chat-completions/generate' || !body || !intent?.requestId || getGenerationRequestId(body)!==intent.requestId) return state.original(input,init);
        state.intent=null;
        const eligible=settings.saveGenerateEnabled && !getContext().groupId && ['openai','custom'].includes(body.chat_completion_source) && Number(body.n ?? 1)===1 && (!body.tools?.length || getCompleteResponseToolName(body));
        if(!eligible) return state.original(input,init);
        let server;
        try { server=await call('/status'); } catch { return state.original(input,init); }
        if(server.protocolVersion!==1 || server.packageVersion!==CURRENT_VERSION || !server.host.supported || !server.capabilities.backgroundJobs || !globalThis.__damsoEarlyBridge) return state.original(input,init);
        const abort=()=>{void cancel();};
        init?.signal?.addEventListener('abort',abort,{once:true});
        try { return await generate(body,intent.target,init?.signal); }
        finally { init?.signal?.removeEventListener('abort',abort); state.active=null; }
    };
    globalThis.fetch=wrapped;
    state.dispose=()=>{ if(globalThis.fetch===wrapped)globalThis.fetch=previous; };
    return state;
}
