/* Damso Tools: loaded before SillyTavern's module entry point. */
(() => {
    if (globalThis.__damsoEarlyBridge || typeof fetch !== 'function') return;
    const original = globalThis.fetch;
    const request = original.bind(globalThis);
    const root = '/api/plugins/st-ko-tools/v1';
    const revisions = new Map();
    const reads = new Map();
    let bundle = null;
    const bridge = globalThis.__damsoEarlyBridge = {
        installed: true, version: '0.1.0', revisions,
        config: {}, configReady: false, originalFetch: request,
        setRevision(target, revision) { if (revision) revisions.set(key(target), revision); },
        getRevision(target) { return revisions.get(key(target)); },
        getReadState(target) { return reads.get(key(target)); },
        clearSettingsGetCache() { bundle = null; },
        dispose() { if (globalThis.fetch === wrapped) globalThis.fetch = original; delete globalThis.__damsoEarlyBridge; },
    };
    const keys = ['SettingsAcceleration','LazyThemeLoading','ExtensionManifestBundle','CharacterListAcceleration','RecentChatListAcceleration','TokenizerBulkCount','ChatKeyboardScanReduction'];
    for (const name of keys) {
        const field = name[0].toLowerCase() + name.slice(1) + 'Enabled';
        bridge['set' + name + 'Enabled'] = enabled => { bridge.config[field] = Boolean(enabled); bridge[field] = Boolean(enabled); if (!enabled) bundle = null; };
        bridge['is' + name + 'Enabled'] = () => bridge.config[field] === true;
    }
    bridge.ready = request(root + '/config', { credentials: 'same-origin', signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null).then(p => {
        if (p?.ok) {
            bridge.config = p.data;
            if(p.data.uiEnabled===false)for(const name of keys)bridge.config[name[0].toLowerCase()+name.slice(1)+'Enabled']=false;
            Object.assign(bridge, bridge.config);bridge.keyboardScanReductionActive=bridge.config.chatKeyboardScanReductionEnabled===true;bridge.configReady=true;
        }
    }).catch(() => {});
    function key(body) { return `${body.avatar_url || '@group'}:${body.file_name ?? body.id ?? body.chatfile ?? body.original_file ?? ''}`.replace(/\.jsonl$/, ''); }
    function json(data, headers = {}) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } }); }
    async function wrapped(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
        if (url.origin !== location.origin || url.pathname.startsWith(root)) return request(input, init);
        const pathname = url.pathname;
        let body;
        if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch {} }
        const chatOperation = /^\/api\/chats\/(?:group\/)?(?:get|save|delete|rename)$/.test(pathname);
        let options = init;
        if (chatOperation && body) {
            if (!pathname.endsWith('/get') && reads.get(key(body))?.success === false) {
                return new Response(JSON.stringify({error:'chat_read_failed',message:'채팅을 다시 불러온 뒤 저장하세요.'}),{status:409,headers:{'Content-Type':'application/json'}});
            }
            const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
            const revision = revisions.get(key(body));
            if (revision && !pathname.endsWith('/get')) headers.set('x-damso-revision', revision);
            options = { ...init, headers };
        }
        if (!pathname.startsWith('/api/plugins/')) {
            await bridge.ready;
            const cfg = bridge.config;
            let accelerated;
            if (pathname === '/api/settings/get' && cfg.settingsAccelerationEnabled) accelerated = '/bootstrap/settings';
            if (pathname === '/api/characters/all' && cfg.characterListAccelerationEnabled && (!body || !Object.keys(body).length)) accelerated = '/characters/list';
            if (pathname === '/api/chats/recent' && cfg.recentChatListAccelerationEnabled) accelerated = '/chats/recent';
            if (accelerated) {
                try { const response = await request(root + accelerated, { ...options, method: 'POST' }); if (response.ok) return response; } catch {}
            }
            if (pathname === '/api/extensions/discover' && cfg.extensionManifestBundleEnabled) {
                try {
                    const response = await request(root + '/extensions/bundle');
                    if (response.ok) { const p = await response.json(); bundle = p.data; return json(bundle.entries); }
                } catch {}
            }
            if (cfg.extensionManifestBundleEnabled && bundle && pathname.startsWith('/scripts/extensions/') && pathname.endsWith('/manifest.json')) {
                const name = decodeURIComponent(pathname.slice('/scripts/extensions/'.length, -'/manifest.json'.length));
                if (bundle.manifests[name]) return json(bundle.manifests[name]);
            }
        }
        let response;
        try { response = await request(input, options); }
        catch(error) {
            if(chatOperation && body && pathname.endsWith('/get'))reads.set(key(body),{success:false,at:Date.now()});
            throw error;
        }
        if(chatOperation && body && pathname.endsWith('/get'))reads.set(key(body),{success:response.ok,at:Date.now()});
        if (chatOperation && body && response.ok) {
            const revision = response.headers.get('x-damso-revision');
            if (revision) revisions.set(key(body), revision);
        }
        return response;
    }
    globalThis.fetch = wrapped;
})();
