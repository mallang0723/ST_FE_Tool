import { api } from './client.js';
import { callGenericPopup, POPUP_TYPE } from '@sillytavern/scripts/popup';
const labels={accepted:'접수됨',running:'생성 중',completed:'생성 완료',committing:'저장 중',saved:'저장됨',conflict:'충돌 · 답변 보관됨',canceled:'취소됨',failed:'실패',interrupted:'서버 종료로 중단됨'};
export function installJobsPanel(container) {
    const section=container.find('#bai_bai_toolkit_tab_baibaoku')[0];
    if(!section || section.querySelector('#damso-jobs-button'))return;
    const button=document.createElement('button');button.id='damso-jobs-button';button.type='button';button.className='menu_button';button.textContent='백그라운드 작업 기록';
    button.style.cssText='width:100%;min-height:2.4em;white-space:normal;padding:6px 10px;';
    button.addEventListener('click',async()=>{
        button.disabled=true;
        try {
            const jobs=await api('/jobs');const body=document.createElement('div');
            const title=document.createElement('h3');title.textContent='백그라운드 작업 기록';body.append(title);
            const help=document.createElement('p');help.textContent='충돌한 답변은 여기 보관됩니다. 내용을 확인해 직접 가져오세요. 채팅을 자동으로 덮어쓰지 않습니다.';body.append(help);
            if(!jobs.length){const empty=document.createElement('p');empty.textContent='기록된 작업이 없습니다.';body.append(empty);}
            for(const job of jobs.slice().reverse()) {
                const item=document.createElement('details');const summary=document.createElement('summary');summary.textContent=(labels[job.status]||job.status)+' · '+job.target.file_name+' · '+new Date(job.createdAt).toLocaleString('ko-KR');item.append(summary);
                if(job.result?.content){const text=document.createElement('textarea');text.value=job.result.content;text.readOnly=true;text.className='text_pole';text.rows=8;text.setAttribute('aria-label','생성한 답변');item.append(text);}
                if(!['saved','conflict','canceled','failed','interrupted'].includes(job.status)){
                    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='작업 중단';cancel.className='menu_button';
                    cancel.addEventListener('click',async()=>{cancel.disabled=true;try{const result=await api('/jobs/'+job.id+'/cancel',{method:'POST',body:'{}'});summary.textContent=(labels[result.status]||result.status)+' · '+job.target.file_name;}catch{cancel.disabled=false;globalThis.toastr?.error('작업 상태를 확인하지 못했습니다.');}});item.append(cancel);
                }
                body.append(item);
            }
            await callGenericPopup(body,POPUP_TYPE.TEXT,'',{okButton:'닫기',wide:true});
        } catch(error){globalThis.toastr?.error(error.message,'담소 도구함');}finally{button.disabled=false;}
    });section.append(button);
}
