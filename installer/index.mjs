import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { PACKAGE_VERSION, HOST_VERSIONS } from '../shared/contracts/index.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
async function read(file) { try { return await fs.readFile(file); } catch(e) { if(e.code==='ENOENT')return null;throw e; } }
async function write(file, data) {
    await fs.mkdir(path.dirname(file),{recursive:true});
    const temp=file+'.damso-'+randomUUID();
    let previous; try { previous=await fs.stat(file); } catch(error) { if(error.code!=='ENOENT')throw error; }
    await fs.writeFile(temp,data,{mode:previous ? previous.mode & 0o777 : 0o600});
    if(previous && process.getuid?.()===0)await fs.chown(temp,previous.uid,previous.gid);
    await fs.rename(temp,file);
}
async function walk(root) {
    const out=[];
    for(const e of await fs.readdir(root,{withFileTypes:true})) {
        if(e.isSymbolicLink())throw new Error('패키지 안의 심볼릭 링크는 허용하지 않습니다.');
        if(e.isDirectory())for(const child of await walk(path.join(root,e.name)))out.push(path.join(e.name,child));
        else out.push(e.name);
    }
    return out;
}
function options(argv) {
    const result={command:'install'};
    for(let i=0;i<argv.length;i++) {
        const word=argv[i];
        if(['install','uninstall','diagnose','recover'].includes(word))result.command=word;
        else if(word==='--image')result.image=true;
        else if(word==='--container-runtime')result.containerRuntime=true;
        else if(['--root','--config','--data-root','--user'].includes(word)) { if(!argv[i+1] || argv[i+1].startsWith('--'))throw new Error(word+' 값이 필요합니다.'); result[word.slice(2)]=argv[++i]; }
        else throw new Error('알 수 없는 인자: '+word);
    }
    if(!result.root)throw new Error('사용법: node install.mjs install|uninstall|diagnose --root <SillyTavern 경로> [--config <파일>] [--data-root <경로>] [--user <사용자>]');
    return result;
}
async function running(port) {
    return new Promise(resolve=>{
        const socket=net.connect({host:'127.0.0.1',port:Number(port)||8000});
        const finish=value=>{socket.destroy();resolve(value);};
        socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(600,()=>finish(false));
    });
}
async function hostProcessRunning(root) {
    if (process.platform !== 'linux') return false;
    for (const pid of await fs.readdir('/proc')) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        try {
            const args = (await fs.readFile('/proc/'+pid+'/cmdline','utf8')).split('\0');
            const cwd = await fs.readlink('/proc/'+pid+'/cwd');
            if (args.some(arg => /(?:^|[/\\])server\.js$/.test(arg) && path.resolve(cwd,arg) === path.join(root,'server.js'))) return true;
        } catch (error) { if (!['ENOENT','EACCES','EPERM','ESRCH'].includes(error.code)) throw error; }
    }
    return false;
}
export async function install(argv = process.argv.slice(2)) {
    const opts=options(argv);
    const root=await fs.realpath(path.resolve(opts.root));
    const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
    if(pkg.name!=='sillytavern' || !HOST_VERSIONS.includes(pkg.version))throw new Error('SillyTavern 1.18.0 또는 1.19.0이 필요합니다.');
    const stateDir=opts.containerRuntime ? path.join(root,'config','.damso-install-runtime') : path.join(root,'.damso-install');const stateFile=path.join(stateDir,'state.json');
    const priorBytes=await read(stateFile);const prior=priorBytes?JSON.parse(priorBytes):null;
    const configPath=await fs.realpath(path.resolve(root,opts.config || prior?.configPath || 'config.yaml'));
    const configBytes=await read(configPath);
    if(!configBytes)throw new Error('실제 설정 파일을 찾지 못했습니다. SillyTavern을 한 번 초기화하거나 --config로 지정하세요.');
    const config=parseDocument(configBytes.toString());
    if(config.errors.length)throw new Error('설정 파일 YAML을 읽지 못했습니다.');
    const dataRoot=path.resolve(root,opts['data-root'] || config.get('dataRoot') || 'data');
    const users=(await fs.readdir(dataRoot,{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.name.startsWith('.')).map(x=>x.name).filter(x=>!['backups','_storage','_cache'].includes(x));
    const user=opts.user || prior?.user || (users.includes('default-user')&&users.length===1?'default-user':users.length===1?users[0]:null);
    if(!user || /[/\\\0]/.test(user) || !users.includes(user))throw new Error('대상 사용자를 --user로 지정하세요. 먼저 해당 사용자로 SillyTavern에 접속해야 합니다.');
    const userRoot=await fs.realpath(path.join(dataRoot,user));
    if(!userRoot.startsWith((await fs.realpath(dataRoot))+path.sep))throw new Error('사용자 경로가 데이터 루트를 벗어납니다.');
    if(opts.command==='diagnose') {
        console.log(JSON.stringify({name:'담소 도구함',version:PACKAGE_VERSION,host:pkg.version,root,configPath,dataRoot,user,installed:prior?.version || null,pluginsEnabled:config.get('enableServerPlugins')===true},null,2));
        if(prior)for(const [file,entry]of Object.entries(prior.files))if(sha(await read(file)||'')!==entry.after)throw new Error('설치 후 변경된 파일: '+file);
        return;
    }
    if(!opts.image && (await hostProcessRunning(root) || await running(config.get('port'))))throw new Error('SillyTavern 또는 설정된 포트가 실행 중입니다. 서버를 종료한 뒤 다시 실행하세요.');
    const pendingBytes=await read(path.join(stateDir,'pending.json'));
    if (opts.command === 'recover') {
        if (!pendingBytes) throw new Error('중단된 설치 기록이 없습니다. 일반 복구는 uninstall을 사용하세요.');
        const pending=JSON.parse(pendingBytes);
        for (const [file,entry] of Object.entries(pending.files)) {
            const current=await read(file);const hash=current===null?null:sha(current);
            if (![entry.before,entry.after,prior?.files[file]?.after ?? null].includes(hash)) throw new Error('중단 이후 수정된 파일입니다: '+file);
        }
        for (const [file,entry] of Object.entries(pending.files)) {
            if(entry.before===null)await fs.rm(file,{force:true});else await write(file,await fs.readFile(path.join(stateDir,entry.backup)));
        }
        if(pending.pluginsWasPresent)config.set('enableServerPlugins',pending.pluginsWasValue);else config.delete('enableServerPlugins');
        await write(configPath,config.toString());
        if(priorBytes)await fs.rename(stateFile,path.join(stateDir,'recovered-'+Date.now()+'.json'));
        await fs.rename(path.join(stateDir,'pending.json'),path.join(stateDir,'recovered-pending-'+Date.now()+'.json'));
        console.log('중단된 설치를 원래 상태로 복구했습니다. 사용자 데이터는 유지했습니다.');return;
    }
    if(pendingBytes)throw new Error('중단된 설치 기록이 있습니다. 같은 경로에 recover 명령을 실행해 복구하세요.');
    if(prior && (prior.user!==user || prior.dataRoot!==dataRoot))throw new Error('기존 설치의 사용자·데이터 경로와 다릅니다. 기존 설치를 먼저 복구하세요.');
    if(prior)for(const [file,entry]of Object.entries(prior.files))if(sha(await read(file)||'')!==entry.after)throw new Error('설치 이후 변경된 파일입니다. 자동 덮어쓰기를 중단했습니다: '+file);
    if(opts.command==='uninstall') {
        if(!prior)throw new Error('설치 기록이 없습니다.');
        for(const [file,entry]of Object.entries(prior.files)) {
            if(entry.before===null)await fs.rm(file,{force:true});
            else await write(file,await fs.readFile(path.join(stateDir,entry.backup)));
        }
        if(prior.pluginsWasPresent)config.set('enableServerPlugins',prior.pluginsWasValue);else config.delete('enableServerPlugins');
        await write(configPath,config.toString());
        await fs.rename(stateFile,path.join(stateDir,'uninstalled-'+Date.now()+'.json'));
        console.log('복구 완료. 사용자 데이터와 다른 설정은 유지했습니다. SillyTavern을 다시 시작하세요.');return;
    }
    const versions=JSON.parse(await fs.readFile(path.join(here,'integration/host-adapters/versions.json'),'utf8'));
    const adapter=versions[pkg.version];
    const changes=new Map();
    for(const [relative,spec]of Object.entries(adapter.files)) {
        const file=path.join(root,relative);
        if(opts.containerRuntime) {
            if(sha(await fs.readFile(file))!==spec.patchedSha256)throw new Error('지원하지 않는 파생 이미지입니다: '+relative);
            continue;
        }
        let source=(prior?.files[file]?.before!==undefined?await fs.readFile(path.join(stateDir,prior.files[file].backup)):await fs.readFile(file)).toString();
        if(sha(source)!==spec.sha256)throw new Error('지원 기준과 다른 호스트 파일입니다. 변경하지 않았습니다: '+relative);
        for(const edit of spec.edits) { if(source.slice(edit.start,edit.start+edit.before.length)!==edit.before)throw new Error('패치 문맥 충돌: '+relative);source=source.slice(0,edit.start)+edit.after+source.slice(edit.start+edit.before.length); }
        changes.set(file,Buffer.from(source));
    }
    for(const [source,target]of [['extension',path.join(userRoot,'extensions/damso-tools')],['server',path.join(root,'plugins/st-ko-tools')]]) {
        for(const file of await walk(path.join(here,source)))changes.set(path.join(target,file),await fs.readFile(path.join(here,source,file)));
    }
    if(!opts.containerRuntime)changes.set(path.join(root,'src/damso-chat-coordinator.mjs'),await fs.readFile(path.join(here,'integration/chat-coordinator.mjs')));
    const records=prior?.files || {};
    const rollback=new Map();
    for(const [file,data]of changes) {
        let ancestor=file;
        while (true) {
            try { await fs.lstat(ancestor); break; } catch (error) { if(error.code!=='ENOENT')throw error; }
            ancestor=path.dirname(ancestor);
        }
        if (await fs.realpath(ancestor) !== ancestor) throw new Error('설치 대상의 심볼릭 링크를 확인해 주세요: '+file);
        const current=await read(file);rollback.set(file,current);
        if(!records[file]) {
            const backup='originals/'+sha(file)+'.bin';
            if(current!==null)await write(path.join(stateDir,backup),current);
            records[file]={before:current===null?null:sha(current),backup};
        }
        records[file].after=sha(data);
    }
    const state={schemaVersion:1,version:PACKAGE_VERSION,hostVersion:pkg.version,hostCommit:adapter.commit,user,dataRoot,configPath,
        pluginsWasPresent:prior?.pluginsWasPresent ?? config.has('enableServerPlugins'),pluginsWasValue:prior?prior.pluginsWasValue:config.get('enableServerPlugins'),files:records};
    // All preflight checks finish before any target is modified; journal allows crash recovery.
    await write(path.join(stateDir,'pending.json'),JSON.stringify(state,null,2));
    try {
        for(const [file,data]of changes)await write(file,data);
        config.set('enableServerPlugins',true);await write(configPath,config.toString());
        await write(stateFile,JSON.stringify(state,null,2));await fs.rm(path.join(stateDir,'pending.json'),{force:true});
    } catch(error) {
        for(const [file,data]of rollback) { if(data===null)await fs.rm(file,{force:true});else await write(file,data); }
        await write(configPath,configBytes);throw error;
    }
    console.log('담소 도구함 '+PACKAGE_VERSION+' 설치 완료. SillyTavern을 한 번 재시작하고 내장 서버 연결 상태를 확인하세요.');
}
if(process.argv[1] && await fs.realpath(path.resolve(process.argv[1])).catch(()=>null)===fileURLToPath(import.meta.url))install().catch(error=>{console.error(error.message);process.exitCode=1;});
