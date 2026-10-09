// One-time AST-aware migration. Does not translate user data, regex literals or sound filenames.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'espree';
import MagicString from 'magic-string';
const catalog=JSON.parse(fs.readFileSync('src/i18n/catalog.json','utf8'));
const map=new Map(Object.entries(catalog).filter(([k])=>k.startsWith('ui.')).map(([k,v])=>[v.source,{key:k,text:v.ko}]));
const residual=[];
for(const file of fs.readdirSync('src',{recursive:true}).filter(f=>f.endsWith('.js')&&!f.startsWith('i18n/'))) {
    const location=path.join('src',file);const source=fs.readFileSync(location,'utf8');const output=new MagicString(source);let imported=false;
    const ast=parse(source,{ecmaVersion:'latest',sourceType:'module',range:true});
    function walk(node) {
        if(!node||typeof node!=='object')return;
        if(node.type==='Literal'&&typeof node.value==='string'&&map.has(node.value)) {
            output.overwrite(node.start,node.end,`koText('${map.get(node.value).key}')`);imported=true;
        } else if(node.type==='TemplateElement'&&map.has(node.value.cooked)) {
            const text=map.get(node.value.cooked).text.replaceAll('\\','\\\\').replaceAll('`','\\`').replaceAll('${','\\${');
            output.overwrite(node.start+1,node.end-(node.tail?1:2),text);
        } else if((node.type==='Literal'||node.type==='TemplateElement')) {
            const value=node.type==='Literal'?node.value:node.value.cooked;
            if(typeof value==='string'&&/\p{Script=Han}/u.test(value)&&!value.endsWith('.mp3')&&!value.includes('/*'))residual.push({file,value});
        }
        for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(walk):walk(value);
    }
    walk(ast);
    if(imported)output.prepend(`import { txt as koText } from '${path.relative(path.dirname(location),'src/i18n/ko.js').replaceAll('\\','/').replace(/^(?!\.)/,'./')}';\n`);
    fs.writeFileSync(location,output.toString());
}
fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/translation-residuals.json',JSON.stringify(residual,null,2));
console.log('번역 후 검토할 문자열: '+residual.length);
