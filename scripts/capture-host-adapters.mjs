// Maintainer tool: regenerate only after reviewing both pinned upstream trees.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'espree';
const repository = process.argv[2];
if (!repository) throw new Error('Pass the reference SillyTavern Git checkout');
const pins = { '1.18.0': '51ad27fb86d39a3daca3adaa970375c9670c12df', '1.19.0': '06bde939fb1e9c4c8d8641d810f0a916b5bce127' };
const adapters = {};
for (const [version,commit] of Object.entries(pins)) {
    const files = {};
    function change(file, transform) {
        const before = execFileSync('git',['-C',repository,'show',commit+':'+file],{maxBuffer:20*1024*1024}).toString();
        const edits = transform(before).map(edit => ({...edit,start:edit.start ?? before.indexOf(edit.before)})).sort((a,b)=>b.start-a.start);
        let after = before;
        for (const edit of edits) {
            if (edit.start < 0 || after.slice(edit.start,edit.start+edit.before.length)!==edit.before) throw new Error('Host context changed: '+file);
            after = after.slice(0,edit.start)+edit.after+after.slice(edit.start+edit.before.length);
        }
        files[file] = { sha256:createHash('sha256').update(before).digest('hex'), patchedSha256:createHash('sha256').update(after).digest('hex'), edits };
    }
    change('public/index.html',()=>[{ before:'<script type="module" src="script.js"></script>',after:'<!-- damso-tools:early -->\n    <script src="/api/plugins/st-ko-tools/v1/assets/early-bridge.js"></script>\n    <script type="module" src="script.js"></script>' }]);
    change('src/endpoints/chats.js',()=>[{ before:'export const router = express.Router();',after:"import { installChatCoordination } from '../damso-chat-coordinator.mjs';\nexport const router = express.Router();\ninstallChatCoordination(router);" }]);
    change('src/endpoints/backends/chat-completions.js', source => {
        const ast = parse(source,{ecmaVersion:'latest',sourceType:'module',range:true});
        const stmt = ast.body.find(n => n.type==='ExpressionStatement' && n.expression?.callee?.object?.name==='router' && n.expression.callee.property?.name==='post' && n.expression.arguments[0]?.value==='/generate');
        if (!stmt) throw new Error('Generation handler missing');
        const handler=stmt.expression.arguments[1];
        const edits = [
            {before:source.slice(stmt.start,handler.body.start+1),after:'export async function damsoGenerate(request, response) {'},
            {before:source.slice(handler.body.end-1,stmt.end)+source.slice(stmt.end,stmt.end+100),after:'}\nrouter.post(\'/generate\', damsoGenerate);'+source.slice(stmt.end,stmt.end+100)},
        ];
        function suppressLogs(node) {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'ExpressionStatement' && node.expression?.callee?.object?.name === 'console') {
                const before = source.slice(node.start,node.end);
                edits.push({ start:node.start, before, after: 'if (!request.damsoBackground) ' + before });
            }
            for (const value of Object.values(node)) if(value&&typeof value==='object') Array.isArray(value)?value.forEach(suppressLogs):suppressLogs(value);
        }
        suppressLogs(handler);
        const errorSend="response.send({ error: { message }, quota_error: quota_error });";
        edits.push({before:errorSend,after:"if (request.damsoBackground) response.status(fetchResponse.status);\n                "+errorSend});
        return edits;
    });
    change('public/scripts/power-user.js',()=>[{before:'let themes = [];',after:`let themes = [];
// Damso: hydrate native theme objects and use the host's complete application path.
globalThis.damsoHydrateTheme = theme => {
    const index = themes.findIndex(item => item.name === theme.name);
    if (index < 0) themes.push(theme); else themes[index] = theme;
};
globalThis.damsoApplyNativeTheme = name => applyTheme(name);
globalThis.damsoThemeNeedsHydration = name => themes.some(theme => theme.name === name && theme.damsoLazy);`}]);
    change('public/scripts/keyboard.js',()=>[
        {before:'function handleNodeChange(node) {',after:"function handleNodeChange(node) {\n    if (globalThis.__damsoEarlyBridge?.keyboardScanReductionActive && node instanceof Element && node.closest('#chat .mes')) return;"},
        {before:'export function makeKeyboardInteractable(...interactables) {\n    interactables.forEach(interactable => {',after:"export function makeKeyboardInteractable(...interactables) {\n    interactables.forEach(interactable => {\n        if (globalThis.__damsoEarlyBridge?.keyboardScanReductionActive && interactable.closest('#chat .mes')) { interactable.setAttribute('tabindex','-1'); return; }"},
    ]);
    adapters[version]={commit,files};
}
fs.mkdirSync('integration/host-adapters',{recursive:true});
fs.writeFileSync('integration/host-adapters/versions.json',JSON.stringify(adapters,null,2)+'\n');
