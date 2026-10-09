import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
const base=path.resolve('.host');
const versions=JSON.parse(await fs.readFile('integration/host-adapters/versions.json','utf8'));
const exists=async file=>fs.access(file).then(()=>true,()=>false);
await fs.mkdir(base,{recursive:true});
const repo=path.join(base,'upstream.git');
if(!await exists(repo))execFileSync('git',['clone','--bare','https://github.com/SillyTavern/SillyTavern.git',repo],{stdio:'inherit'});
for(const [version,spec] of Object.entries(versions)) {
    const root=path.join(base,version);const fresh=!await exists(path.join(root,'package.json'));
    if(fresh){
        await fs.mkdir(root,{recursive:true});
        const archive=execFileSync('git',['--git-dir',repo,'archive',spec.commit],{maxBuffer:128*1024*1024});
        execFileSync('tar',['-xf','-','-C',root],{input:archive});
    }
    const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
    if(pkg.name!=='sillytavern'||pkg.version!==version)throw new Error('기존 테스트 호스트의 버전이 다릅니다: '+root);
    execFileSync('npm',['ci','--omit=dev','--cache','/tmp/damso-npm-cache'],{cwd:root,stdio:'inherit'});
    if(!await exists(path.join(root,'data/default-user/settings.json'))){
        const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
        const host=spawn(process.execPath,['server.js','--port',String(port),'--listen','false','--autorun','false'],{cwd:root,stdio:['ignore','ignore','inherit']});
        try{
            let ready=false;
            for(let i=0;i<120;i++){
                if(host.exitCode!==null)throw new Error('테스트 호스트 초기화 실패');
                try{const r=await fetch('http://127.0.0.1:'+port+'/csrf-token');if(r.ok){ready=true;break;}}catch{}
                await new Promise(r=>setTimeout(r,500));
            }
            if(!ready)throw new Error('테스트 호스트 초기화 시간 초과');
        }finally{if(host.exitCode===null){const exited=once(host,'exit');host.kill('SIGTERM');await exited;}}
        const settingsFile=path.join(root,'data/default-user/settings.json');
        const settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));
        Object.assign(settings,{main_api:'openai',username:'개발 확인',firstRun:false,language:'ko-kr'});
        await fs.writeFile(settingsFile,JSON.stringify(settings,null,2));
    }
    execFileSync(process.execPath,[path.resolve('release/damso-tools-0.1.0/install.mjs'),'install','--root',root,'--user','default-user'],{stdio:'inherit'});
    const installed=JSON.parse(await fs.readFile(path.join(root,'.damso-install/state.json'),'utf8'));
    if(installed.hostVersion!==version)throw new Error('설치 결과를 확인하지 못했습니다: '+root);
}
console.log('1.18.0·1.19.0 테스트 호스트 준비 완료. 실제 사용자 설치와 별도인 .host 디렉터리입니다.');
