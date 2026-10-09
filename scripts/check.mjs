import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'espree';
import assert from 'node:assert/strict';
for(const folder of ['src','server','shared','integration','installer','scripts','tests','docker']) {
    for(const name of fs.readdirSync(folder,{recursive:true}).filter(x=>/\.(m?js)$/.test(x))) {
        const file=folder+'/'+name;execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
        if(folder!=='src')continue;
        const source=fs.readFileSync(file,'utf8');
        assert.ok(!source.includes('/api/plugins/baibaoku/'),'외부 백엔드 주소: '+file);
        assert.ok(!source.includes('globalThis.BaiBaoKu'),'외부 DB 브리지: '+file);
        parse(source,{ecmaVersion:'latest',sourceType:'module'});
    }
}
const version=JSON.parse(fs.readFileSync('package.json')).version;
assert.equal(JSON.parse(fs.readFileSync('manifest.json')).version,version);
console.log('구문·외부 백엔드 의존성·버전 검사 통과');
