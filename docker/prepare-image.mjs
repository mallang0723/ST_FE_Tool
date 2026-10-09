import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(process.argv[2] || '/home/node/app');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const adapters=JSON.parse(await fs.readFile(path.join(packageRoot,'integration/host-adapters/versions.json'),'utf8'));
if(!adapters[version])throw new Error('지원하지 않는 SillyTavern 이미지 버전입니다.');
const changes=[];
for(const [file,spec]of Object.entries(adapters[version].files)) {
    let source=await fs.readFile(path.join(root,file),'utf8');
    if(createHash('sha256').update(source).digest('hex')!==spec.sha256)throw new Error('이미지 파일의 문맥이 다릅니다: '+file);
    for(const edit of spec.edits) { if(source.slice(edit.start,edit.start+edit.before.length)!==edit.before)throw new Error('패치 문맥 오류');source=source.slice(0,edit.start)+edit.after+source.slice(edit.start+edit.before.length); }
    changes.push([file,source]);
}
for(const [file,source]of changes)await fs.writeFile(path.join(root,file),source);
await fs.copyFile(path.join(packageRoot,'integration/chat-coordinator.mjs'),path.join(root,'src/damso-chat-coordinator.mjs'));
await fs.chmod(path.join(root,'src/damso-chat-coordinator.mjs'),0o644);
