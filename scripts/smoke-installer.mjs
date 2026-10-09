import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse, stringify } from 'yaml';

// Run against a disposable, minimal copy; never uninstall the supplied real host.
const reference=path.resolve(process.argv[2] || '.host/1.19.0');
const pkg=JSON.parse(await fs.readFile(path.join(reference,'package.json')));
const adapters=JSON.parse(await fs.readFile('integration/host-adapters/versions.json'));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'damso-installer-'));
const installer=path.resolve('release/damso-tools-0.1.0/install.mjs');
const run=command=>execFileSync(process.execPath,[installer,command,'--root',root,'--user','default-user'],{encoding:'utf8'});
try {
    let prior;try{prior=JSON.parse(await fs.readFile(path.join(reference,'.damso-install/state.json')));}catch{}
    const originals=new Map();
    for(const relative of Object.keys(adapters[pkg.version].files)) {
        const entry=prior?.files[path.join(reference,relative)];
        const bytes=await fs.readFile(entry ? path.join(reference,'.damso-install',entry.backup) : path.join(reference,relative));
        originals.set(relative,bytes);await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),bytes);
    }
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify(pkg));
    await fs.mkdir(path.join(root,'data/default-user/st-ko-tools'),{recursive:true});
    const sentinel=path.join(root,'data/default-user/st-ko-tools/preserved.json');
    await fs.writeFile(sentinel,'{"keep":"사용자 데이터"}');
    const configPath=path.join(root,'config.yaml');
    await fs.writeFile(configPath,stringify({port:18999,enableServerPlugins:false,enableServerPluginsAutoUpdate:false,dataRoot:'data',customField:'원래 값'}));
    run('install');run('install');run('diagnose');
    const edited=parse(await fs.readFile(configPath,'utf8'));edited.customField='설치 후 변경';await fs.writeFile(configPath,stringify(edited));
    run('uninstall');
    for(const [relative,bytes] of originals)assert.deepEqual(await fs.readFile(path.join(root,relative)),bytes);
    let restored=parse(await fs.readFile(configPath,'utf8'));assert.equal(restored.enableServerPlugins,false);assert.equal(restored.customField,'설치 후 변경');assert.equal(restored.enableServerPluginsAutoUpdate,false);
    assert.equal(await fs.readFile(sentinel,'utf8'),'{"keep":"사용자 데이터"}');
    const target=path.join(root,'public/index.html');await fs.appendFile(target,'\n<!-- user edit -->');
    assert.throws(()=>run('install'),/지원 기준과 다른 호스트/);
    assert.equal(parse(await fs.readFile(configPath,'utf8')).enableServerPlugins,false);
    await fs.writeFile(target,originals.get('public/index.html'));
    run('install');
    await fs.rename(path.join(root,'.damso-install/state.json'),path.join(root,'.damso-install/pending.json'));
    run('recover');
    for(const [relative,bytes] of originals)assert.deepEqual(await fs.readFile(path.join(root,relative)),bytes);
    assert.equal(await fs.readFile(sentinel,'utf8'),'{"keep":"사용자 데이터"}');
    console.log(JSON.stringify({host:pkg.version,checks:['fresh install','repeat update','diagnose','exact host rollback','preserve config edits and auto-update policy','preserve user data','modified host rejection before writes','journal recovery']}));
} finally {await fs.rm(root,{recursive:true,force:true});}
