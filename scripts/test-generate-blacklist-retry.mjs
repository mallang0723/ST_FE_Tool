import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'espree';
import * as generateRequest from '../src/features/generateRequest.js';
import * as soundConstants from '../src/chat/constants.js';
import { txt } from '../src/i18n/ko.js';
const GENERATE_BLACKLIST_SETTLED_EVENT = 'bai_bai_toolkit_blacklist_settled';

// Exercise the real modules with isolated ST imports, without a browser, server,
// real chats, or paid generation requests.
async function loadModule(file, context, mocks) {
    const code = await readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8');
    const imports = parse(code, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .filter(node => node.type === 'ImportDeclaration');
    const dependencies = new Map();
    const module = new vm.SourceTextModule(code, {
        context,
        identifier: file,
        initializeImportMeta: meta => { meta.url = new URL(`../src/features/${file}`, import.meta.url).href; },
    });
    await module.link(source => {
        if (!dependencies.has(source)) {
            const values = source.endsWith('/i18n/ko.js') ? { txt } : mocks[source] || {};
            const names = new Set(Object.keys(values));
            for (const entry of imports.filter(entry => entry.source.value === source)) {
                for (const specifier of entry.specifiers) {
                    if (specifier.type === 'ImportSpecifier') names.add(specifier.imported.name);
                    if (specifier.type === 'ImportDefaultSpecifier') names.add('default');
                }
            }
            dependencies.set(source, new vm.SyntheticModule([...names], function () {
                for (const name of names) this.setExport(name, values[name]);
            }, { context }));
        }
        return dependencies.get(source);
    });
    await module.evaluate();
    return { exports: module.namespace, dependencies };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function harness(options = {}) {
    const events = ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'CHARACTER_MESSAGE_RENDERED',
        'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED',
        'MESSAGE_DELETED', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATE_AFTER_DATA'];
    const event_types = Object.fromEntries(events.map(event => [event, event]));
    const listeners = new Map();
    const eventSource = {
        on(event, listener) {
            listeners.set(event, [...(listeners.get(event) || []), listener]);
        },
        listenerCount(event) { return (listeners.get(event) || []).length; },
        removeListener(event, listener) {
            listeners.set(event, (listeners.get(event) || []).filter(entry => entry !== listener));
        },
        async emit(event, ...args) {
            for (const listener of [...(listeners.get(event) || [])]) await listener(...args);
        },
    };
    const settings = {
        messageCompletionSoundEnabled: false,
        messageCompletionSoundSource: 'url',
        messageCompletionSoundUrl: 'https://example.invalid/completion.mp3',
        messageCompletionSoundVolume: 0.5,
        generateBlacklistRetryEnabled: true,
        generateBlacklistRetryText: 'blocked\n\u62b1\u6b49',
        generateRetryEnabled: true,
        generateRetryMaxRetries: 3,
        ...options.settings,
    };
    const extensionState = {};
    const work = { contextReads: 0, timersScheduled: 0, timersFired: 0, maxPendingTimers: 0 };
    const soundPlays = [];
    class MockAudio {
        constructor(src = '') { this.src = src; this.currentTime = 0; this.paused = true; }
        pause() { this.paused = true; }
        load() {}
        setAttribute() {}
        removeAttribute(name) { if (name === 'src') this.src = ''; }
        async play() {
            this.paused = false;
            if (!this.loop) soundPlays.push({ src: this.src, at: now });
        }
    }
    const notices = [];
    const logEntries = [];
    const saves = [];
    const calls = [];
    const deletions = [];
    const errors = [];
    const scriptModules = [];
    const timers = new Map();
    const responses = [...(options.responses || ['accepted'])];
    const apiResponses = [...(options.apiResponses || [])];
    const apiRequests = [];
    let now = 0;
    let serial = 0;
    let script;
    let context;
    const setFlag = (name, value) => {
        script[name] = value;
        for (const module of scriptModules) module.setExport(name, value);
    };
    const st = {
        chat: options.chat || [{ is_user: true, mes: 'prompt' }],
        characterId: 0,
        chatId: 'test-chat',
        groupId: null,
        chatMetadata: { integrity: 'test' },
        characters: [{ name: 'Test', avatar: 'test.png' }],
        powerUserSettings: {},
        streamingProcessor: null,
        getCurrentChatId: () => st.chatId,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        deactivateSendButtons() {},
        activateSendButtons() {
            setFlag('is_send_press', false);
            void eventSource.emit(event_types.GENERATION_ENDED);
        },
        addOneMessage() {},
        async deleteLastMessage() {
            deletions.push(st.chat.pop());
            await eventSource.emit(event_types.MESSAGE_DELETED, st.chat.length);
        },
        async generate(type, args) {
            calls.push({ type, args, prompt: null });
            await begin(type, args);
            if (st.chat.length && !st.chat.at(-1).is_user) await st.deleteLastMessage();
            calls.at(-1).prompt = st.chat.map(message => message.mes);
            const response = options.apiResponses ? await requestReply(type) : responses.shift() ?? 'accepted';
            if (response instanceof Error) {
                setFlag('is_send_press', false);
                await eventSource.emit(event_types.GENERATION_ENDED);
                throw response;
            }
            await finish(response, { streaming: options.streamingRetries });
        },
    };
    script = {
        event_types,
        eventSource,
        // Real script.js does not export getContext; it belongs to extensions.js.
        setSendButtonState: value => setFlag('is_send_press', value),
        is_send_press: false,
        isChatSaving: false,
    };
    const constants = {
        GENERATE_BLACKLIST_SETTLED_EVENT,
        LOG_PREFIX: '[test]',
        CURRENT_VERSION: 'test',
        GENERATE_RETRY_BASE_DELAY_MS: 1500,
        GENERATE_RETRY_DEFAULT_RETRIES: 3,
        GENERATE_RETRY_MIN_RETRIES: 1,
        GENERATE_RETRY_MAX_RETRIES: 10,
        GENERATE_RETRY_MAX_DELAY_MS: 15_000,
        GENERATE_RETRY_MESSAGE_TYPES: new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate']),
        GENERATE_RETRY_PATHS: new Set(['/api/backends/chat-completions/generate']),
        GENERATE_RETRY_FETCH_KEY: '__requestRetry',
        GENERATE_RETRY_PERMANENT_STATUSES: new Set([400, 401, 403, 404, 413, 422, 499]),
        GENERATE_RETRY_REASON_MAX_LENGTH: 60,
        BAIBAOKU_SAVE_GENERATE_URL: '/save-generate',
    };
    context = vm.createContext({
        Date: class extends Date { static now() { return now; } },
        setTimeout(fn, delay) {
            timers.set(++serial, { fn, at: now + delay });
            work.timersScheduled++;
            work.maxPendingTimers = Math.max(work.maxPendingTimers, timers.size);
            return serial;
        },
        clearTimeout: id => timers.delete(id),
        console: Object.fromEntries(['debug', 'log', 'info', 'warn', 'error'].map(level => [level, (...args) => logEntries.push({ level, args })])),
        Audio: MockAudio, HTMLAudioElement: MockAudio, document: new EventTarget(),
        AbortController, AbortSignal, Response, Request, Headers, URL,
        location: new URL('http://localhost/'),
        toastr: Object.fromEntries(['warning', 'error'].map(level => [level, (...args) => notices.push({ level, args })])),
        fetch: async (url, init) => {
            if (options.fetch) return options.fetch(url, init);
            if (url === '/api/backends/chat-completions/generate') {
                apiRequests.push(JSON.parse(init.body));
                assert.ok(apiResponses.length, 'generation exceeded the supplied response sequence');
                const result = apiResponses.shift();
                if (result instanceof Error) throw result;
                const payload = typeof result === 'string'
                    ? { choices: [{ message: { content: result } }] }
                    : typeof result === 'number' ? { error: 'temporary failure' } : result;
                return new Response(JSON.stringify(payload), {
                    status: typeof result === 'number' ? result : 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            assert.equal(url, '/api/chats/save');
            saves.push(JSON.parse(init.body));
            return { ok: true, status: 200 };
        },
    });
    const lifecycle = await loadModule('generationLifecycle.js', context, {
        '@sillytavern/script': script,
        './constants.js': constants,
        './state.js': { settings, extensionState },
    });
    lifecycle.exports.installGenerationLifecycle();
    const retry = await loadModule('generateRetry.js', context, {
        '@sillytavern/script': script,
        './generateRequest.js': generateRequest,
        './constants.js': constants,
        './generationLifecycle.js': lifecycle.exports,
        './state.js': { settings, extensionState },
        './gzipHook.js': {
            getFetchRequestMethod: (input, init) => init?.method || 'GET',
            getFetchRequestUrl: input => String(input),
            isFetchRequest: input => input instanceof Request,
        },
        './util.js': { readFetchJsonBody: async (input, init) => {
            try { return JSON.parse(init?.body ?? await input.clone().text()); } catch { return null; }
        } },
    });
    scriptModules.push(retry.dependencies.get('@sillytavern/script'));
    retry.exports.installGenerateRetryFetchHook();
    const feature = await loadModule('generateBlacklistRetry.js', context, {
        '@sillytavern/script': script,
        '@sillytavern/scripts/extensions': { getContext: () => { work.contextReads++; return st; } },
        './constants.js': constants,
        './state.js': { settings, extensionState },
        './generateRetry.js': retry.exports,
        './generationLifecycle.js': lifecycle.exports,
    });
    scriptModules.push(feature.dependencies.get('@sillytavern/script'));
    const sound = await loadModule('../chat/completionSound.js', context, {
        '@sillytavern/script': script,
        '@sillytavern/scripts/RossAscends-mods': { isMobile: () => Boolean(options.mobile) },
        '../features/constants.js': constants,
        './constants.js': soundConstants,
        './state.js': { settings, extensionState, LOG_PREFIX: '[test]' },
    });
    if (options.soundFirst) sound.exports.applyMessageCompletionSound();
    feature.exports.installGenerateBlacklistRetry();
    if (!options.soundFirst) sound.exports.applyMessageCompletionSound();

    async function begin(type = 'normal', args = {}, dryRun = false) {
        await eventSource.emit(event_types.GENERATION_STARTED, type, args, dryRun);
        await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, args, dryRun);
        if (!dryRun) setFlag('is_send_press', true);
    }
    async function requestReply(type = 'normal', signal = new AbortController().signal) {
        try {
            const body = { type, stream: false, messages: st.chat.map(message => ({ content: message.mes })) };
            await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, body);
            const response = await context.fetch('/api/backends/chat-completions/generate', {
                method: 'POST', body: JSON.stringify(body), signal,
            });
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(`Generation failed: HTTP ${response.status}`);
            return data.choices[0].message.content;
        } catch (error) {
            setFlag('is_send_press', false);
            await eventSource.emit(event_types.GENERATION_ENDED);
            throw error;
        }
    }
    async function finish(text, { streaming = false, holdSave = false, reasoning = '' } = {}) {
        st.chat.push({ is_user: false, mes: text, swipe_id: 0, extra: { reasoning } });
        if (streaming) {
            st.streamingProcessor = { isFinished: true, isStopped: false, abortController: new AbortController() };
            setFlag('is_send_press', false);
            await eventSource.emit(event_types.GENERATION_ENDED);
        }
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, st.chat.length - 1, 'normal');
        setFlag('isChatSaving', holdSave);
        if (!streaming) {
            setFlag('is_send_press', false);
            await eventSource.emit(event_types.GENERATION_ENDED);
        }
        if (!holdSave) st.streamingProcessor = null;
    }
    async function advance(ms) {
        const target = now + ms;
        let steps = 0;
        while (true) {
            const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            assert.ok(++steps < 1000, 'timer loop did not settle');
            now = next[1].at;
            timers.delete(next[0]);
            work.timersFired++;
            try {
                const result = next[1].fn();
                if (result?.catch) result.catch(error => errors.push(error));
            } catch (error) { errors.push(error); }
            await setImmediate();
        }
        now = target;
        await setImmediate();
        assert.deepEqual(errors, []);
    }
    return { st, settings, feature: feature.exports, retry: retry.exports, begin, finish, advance,
        eventSource, event_types, calls, saves, deletions, notices, logEntries, setFlag, context, timers, apiRequests, requestReply,
        sound: sound.exports, soundPlays, extensionState, work,
        get run() { return extensionState.generateBlacklistRetry.run; } };
}

test('literal lines: Chinese, case folding, CRLF, blank lines and regex characters', async () => {
    const h = await harness();
    const entries = h.feature.parseGenerateBlacklist(' \u62b1\u6b49 \r\n\r\n.*\nI CANNOT\n\u62b1\u6b49\n');
    assert.deepEqual([...entries], ['\u62b1\u6b49', '.*', 'I CANNOT']);
    assert.equal(h.feature.findGenerateBlacklistMatch('\u975e\u5e38\u62b1\u6b49', entries), '\u62b1\u6b49');
    assert.equal(h.feature.findGenerateBlacklistMatch('i cannot help', entries), 'I CANNOT');
    assert.equal(h.feature.findGenerateBlacklistMatch('normal text', entries), '');
    assert.equal(h.feature.findGenerateBlacklistMatch('literal .* pattern', entries), '.*');
});

test('regex lines support flags and stay opt-in per line', async () => {
    const h = await harness();
    const entries = h.feature.parseGenerateBlacklist(
        '/blocked/\n/blocked/i\n/a.b/s\n/^Error:/m\n/(retry)/\n/timeout|504/i\n抱歉');
    // 不加 i 的正则区分大小写；普通行仍然忽略大小写。
    assert.equal(h.feature.findGenerateBlacklistMatch('BLOCKED', entries), '/blocked/i');
    assert.equal(h.feature.findGenerateBlacklistMatch('blocked', entries), '/blocked/');
    assert.equal(h.feature.findGenerateBlacklistMatch('非常抱歉', entries), '抱歉');
    // s 让 . 匹配换行，m 让 ^ 匹配行首，括号按正则分组解释。
    assert.equal(h.feature.findGenerateBlacklistMatch('a\nb', entries), '/a.b/s');
    assert.equal(h.feature.findGenerateBlacklistMatch('note\nError: 503', entries), '/^Error:/m');
    assert.equal(h.feature.findGenerateBlacklistMatch('please (retry)', entries), '/(retry)/');
    assert.equal(h.feature.findGenerateBlacklistMatch('HTTP 504 Bad Gateway', entries), '/timeout|504/i');
    assert.equal(h.feature.findGenerateBlacklistMatch('nothing here', entries), '');
});

test('global and sticky regex entries keep matching across repeated checks', async () => {
    const h = await harness();
    const entries = h.feature.parseGenerateBlacklist('/503/g\n/blocked/y');
    for (let round = 0; round < 3; round++) {
        assert.equal(h.feature.findGenerateBlacklistMatch('HTTP 503', entries), '/503/g');
        assert.equal(h.feature.findGenerateBlacklistMatch('blocked', entries), '/blocked/y');
    }
});

test('lines that are not valid /pattern/flags stay literal and invalid regex warns once', async () => {
    const h = await harness();
    const entries = h.feature.parseGenerateBlacklist('http://example.com\n//\n/  /\n/foo(/i');
    // // 不是空正则，而是普通文本，不会命中任意回复。
    assert.equal(h.feature.findGenerateBlacklistMatch('anything', entries), '');
    assert.equal(h.feature.findGenerateBlacklistMatch('a // b', entries), '//');
    assert.equal(h.feature.findGenerateBlacklistMatch('visit http://example.com now', entries), 'http://example.com');
    assert.equal(h.feature.findGenerateBlacklistMatch('literal /foo(/i text', entries), '/foo(/i');
    assert.equal(h.feature.findGenerateBlacklistMatch('foo( text', entries), '');
    assert.equal(h.logEntries.length, 1, 'invalid regex must warn only once');
    assert.equal(h.logEntries[0].level, 'warn');
    assert.ok(h.logEntries[0].args[0].includes('/foo(/i'));
    assert.equal(h.feature.findGenerateBlacklistMatch('literal /foo(/i text', entries), '/foo(/i');
    assert.equal(h.logEntries.length, 1, 'the warning must not repeat on later checks');
});

test('blacklist input follows the saved toggle and preserves its text when hidden', async () => {
    for (const enabled of [false, true]) {
        const h = await harness({ settings: { generateBlacklistRetryEnabled: enabled } });
        const elements = new Map();
        h.context.$ = selector => {
            if (typeof selector !== 'string') return selector;
            if (!elements.has(selector)) elements.set(selector, {
                handlers: new Map(),
                prop(key, value) {
                    if (arguments.length === 1) return this[key];
                    this[key] = value;
                    return this;
                },
                val(...args) { return this.prop('value', ...args); },
                toggle(visible) { this.visible = visible; return this; },
                off(event) { this.handlers.delete(event); return this; },
                on(event, handler) { this.handlers.set(event, handler); return this; },
                input() { for (const handler of this.handlers.values()) handler.call(this); },
            });
            return elements.get(selector);
        };
        let saved = 0;
        const bind = () => h.feature.bindGenerateBlacklistRetrySettings({ saveSettings: () => saved++ });
        bind();
        const toggle = elements.get('#bai_bai_toolkit_generate_blacklist_retry_enabled');
        const text = elements.get('#bai_bai_toolkit_generate_blacklist_retry_text');
        assert.equal(toggle.checked, enabled);
        assert.equal(text.visible, enabled);
        assert.equal(text.value, h.settings.generateBlacklistRetryText);
        assert.equal(saved, 0);
        for (const checked of [true, false, true]) {
            toggle.checked = checked;
            toggle.input();
            assert.equal(text.visible, checked);
            assert.equal(h.settings.generateBlacklistRetryEnabled, checked);
            assert.equal(text.value, h.settings.generateBlacklistRetryText);
        }
        assert.equal(saved, 3);
        text.value = 'edited blacklist';
        text.input();
        assert.equal(h.settings.generateBlacklistRetryText, 'edited blacklist');
        bind();
        toggle.checked = false;
        toggle.input();
        assert.equal(text.visible, false);
        assert.equal(text.value, 'edited blacklist');
        assert.equal(h.settings.generateBlacklistRetryText, 'edited blacklist');
        assert.equal(saved, 5);
    }
});

for (const streaming of [false, true]) {
    test(`retries a completed ${streaming ? 'streaming' : 'non-streaming'} reply, preserving its prompt`, async () => {
        const h = await harness({ streamingRetries: streaming });
        await h.begin();
        await h.finish('blocked response', { streaming });
        await h.advance(2000);
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].type, 'regenerate');
        assert.deepEqual(h.calls[0].prompt, ['prompt']);
        assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'accepted']);
        assert.equal(h.run, null);
    });
}

test('does not discard the earlier assistant reply when no new user message exists', async () => {
    const prior = { is_user: false, mes: 'earlier valid reply' };
    const h = await harness({ chat: [{ is_user: true, mes: 'prompt' }, prior] });
    await h.begin();
    await h.finish('blocked response');
    await h.advance(2000);
    assert.equal(h.st.chat[1], prior);
    assert.deepEqual(h.calls[0].prompt, ['prompt', 'earlier valid reply']);
});

test('waits for stream and chat save to settle after the end event', async () => {
    const h = await harness();
    await h.begin();
    await h.finish('blocked response', { streaming: true, holdSave: true });
    await h.advance(5000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.deletions.length, 0);
    h.setFlag('isChatSaving', false);
    await h.advance(2000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.deletions.length, 0);
    h.st.streamingProcessor = null;
    await h.advance(2000);
    assert.equal(h.calls.length, 1);
});

test('enforces a finite chain and retains the final rejected reply without extra deletion or saving', async () => {
    const h = await harness({ responses: ['blocked 1', 'blocked 2', 'blocked 3'] });
    await h.begin();
    await h.finish('blocked initial');
    await h.advance(10_000);
    assert.equal(h.calls.length, 3);
    assert.equal(h.deletions.length, 3); // Only native regenerate replaces a reply.
    assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'blocked 3']);
    assert.equal(h.saves.length, 0);
    assert.equal(h.run, null);
    assert.equal(h.timers.size, 0);
    assert.ok(h.notices.some(notice => notice.args[0].includes('마지막 답변')));
});

test('does not scan old messages or the separate reasoning field', async () => {
    const h = await harness({ chat: [{ is_user: true, mes: 'blocked history' }] });
    await h.begin();
    await h.finish('accepted', { reasoning: 'blocked reasoning' });
    await h.advance(3000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.run, null);
});

test('handles an original regenerate operation', async () => {
    const h = await harness({ chat: [{ is_user: true, mes: 'prompt' }, { is_user: false, mes: 'old reply' }] });
    await h.begin('regenerate');
    await h.st.deleteLastMessage();
    await h.finish('blocked');
    await h.advance(3000);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'accepted']);
});

test('does not mistake a second rendered message for the native reply', async () => {
    const h = await harness();
    await h.begin();
    await h.finish('accepted native reply');
    await h.finish('blocked message from another source');
    await h.advance(3000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.deletions.length, 0);
});

for (const mode of ['disabled', 'empty', 'group', 'quiet', 'continue', 'swipe', 'impersonate', 'dry-run', 'native-auto-swipe']) {
    test(`skips ${mode}`, async () => {
        const h = await harness();
        if (mode === 'disabled') h.settings.generateBlacklistRetryEnabled = false;
        if (mode === 'empty') h.settings.generateBlacklistRetryText = ' \n';
        if (mode === 'group') h.st.groupId = 'group';
        if (mode === 'native-auto-swipe') h.st.powerUserSettings.auto_swipe = true;
        const type = ['quiet', 'continue', 'swipe', 'impersonate'].includes(mode) ? mode : 'normal';
        await h.begin(type, {}, mode === 'dry-run');
        await h.finish('blocked');
        await h.advance(5000);
        assert.equal(h.calls.length, 0);
        assert.equal(h.deletions.length, 0);
    });
}

for (const action of ['stop', 'switch-chat', 'disable', 'edit', 'append', 'new-generation']) {
    test(`cancels pending retries on ${action}`, async () => {
        const h = await harness();
        await h.begin();
        await h.finish('blocked');
        await h.advance(100);
        if (action === 'stop') await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
        if (action === 'switch-chat') {
            h.st.chat = [{ is_user: true, mes: 'other chat' }];
            h.st.chatId = 'other';
            await h.eventSource.emit(h.event_types.CHAT_CHANGED);
        }
        if (action === 'disable') h.settings.generateBlacklistRetryEnabled = false;
        if (action === 'edit') h.st.chat.at(-1).mes = 'manually edited';
        if (action === 'append') h.st.chat.push({ is_user: true, mes: 'new prompt' });
        if (action === 'new-generation') await h.begin('continue');
        await h.advance(5000);
        assert.equal(h.calls.length, 0);
        assert.equal(h.deletions.length, 0);
    });
}

test('request retry is not re-armed when a stop lands in the startup window', async () => {
    const h = await harness({ settings: { generateBlacklistRetryEnabled: false }, apiResponses: [503, 503] });
    let stopped = false;
    h.eventSource.on(h.event_types.GENERATION_STARTED, async () => {
        if (stopped) return;
        stopped = true;
        // 停止落在酒馆重建 abortController 之前:同一代会继续走到 AFTER_COMMANDS。
        await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
    });
    await h.begin();
    const reply = h.requestReply().catch(error => `ERR: ${error.message}`);
    await setImmediate();
    await h.advance(10_000);
    assert.equal(await reply, 'ERR: Generation failed: HTTP 503');
    assert.equal(h.apiRequests.length, 1);
    assert.deepEqual(h.notices, [], 'a stopped generation must not retry or toast');
});

test('generation stop cancels a pending request retry without a fetch signal', async () => {
    const h = await harness({ settings: { generateBlacklistRetryEnabled: false }, apiResponses: [503, 503] });
    await h.begin();
    const reply = h.requestReply('normal', null).catch(error => `ERR: ${error.message}`);
    await setImmediate();
    assert.equal(h.apiRequests.length, 1);
    await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
    await h.advance(10_000);
    assert.equal(await reply, 'ERR: Generation failed: HTTP 503');
    assert.equal(h.apiRequests.length, 1, 'the pending retry must be cancelled by the stop');
    assert.equal(h.notices.length, 1, 'the pending retry notice is shown before the stop cancels it');
});

test('blacklist retry is not re-armed when a stop lands in the regenerated startup', async () => {
    const h = await harness({ apiResponses: ['blocked', 'blocked again'] });
    let stopped = false;
    h.eventSource.on(h.event_types.GENERATION_STARTED, async (type, options) => {
        if (stopped || type !== 'regenerate' || options?.automatic_trigger !== true) return;
        stopped = true;
        await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
    });
    await h.begin();
    await h.finish(await h.requestReply());
    await h.advance(10_000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.run, null);
    assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'blocked again']);
});

test('stop swallowed before the regenerated STARTED keeps the shared retry budget', async () => {
    const h = await harness({ settings: { generateRetryMaxRetries: 2 }, apiResponses: ['blocked', 'blocked again', 'accepted'] });
    let swallowed = 0;
    const originalGenerate = h.st.generate;
    h.st.generate = async (type, args) => {
        if (type === 'regenerate' && swallowed === 0) {
            swallowed += 1;
            // 停止早于这一代自己的 GENERATION_STARTED:酒馆随后照旧启动它。
            await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
        }
        return originalGenerate(type, args);
    };
    await h.begin();
    const run = h.run;
    await h.finish(await h.requestReply());
    await h.advance(2000);
    assert.equal(swallowed, 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.run, run, 'the swallowed stop must not drop the chain');
    assert.equal(run.retries, 1);
    await h.advance(10_000);
    assert.equal(h.calls.length, 2);
    assert.equal(run.retries, 2, 'the preserved budget must not reset to zero');
    assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'accepted']);
    assert.equal(h.run, null);
});

test('blacklist retry toasts use their own title', async () => {
    const h = await harness({ settings: { generateRetryMaxRetries: 1 } });
    await h.begin();
    await h.finish('blocked');
    await h.advance(2000);
    const hit = h.notices.find(notice => String(notice.args[0]).includes('지정 문구'));
    assert.ok(hit);
    assert.equal(hit.args[1], '지정 문구 감지 시 재생성');
});

test('aborted streaming output is not treated as a completed reply', async () => {
    const h = await harness();
    await h.begin();
    await h.finish('blocked', { streaming: true, holdSave: true });
    h.st.streamingProcessor.abortController.abort();
    h.setFlag('isChatSaving', false);
    h.st.streamingProcessor = null;
    await h.advance(5000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.deletions.length, 0);
});

test('a save starting during the retry delay postpones regeneration instead of cancelling it', async () => {
    const h = await harness();
    await h.begin();
    await h.finish('blocked response');
    await h.advance(100);
    assert.equal(h.run.phase, 'waiting');
    h.setFlag('isChatSaving', true);
    await h.advance(3000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.run.phase, 'waiting');
    h.setFlag('isChatSaving', false);
    await h.advance(2000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.st.chat.at(-1).mes, 'accepted');
});

for (const event of ['MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
    test(`only changes to the generated floor cancel retries (${event})`, async () => {
        for (const messageId of [0, 1]) {
            const h = await harness();
            await h.begin();
            await h.finish('blocked response');
            await h.advance(100);
            await h.eventSource.emit(h.event_types[event], messageId);
            await h.advance(2000);
            assert.equal(h.calls.length, messageId === 0 ? 1 : 0);
        }
    });
}

for (const when of ['before-check', 'during-delay']) {
    test(`reads the current floor instead of a stale message snapshot (${when})`, async () => {
        for (const text of ['blocked replacement', 'accepted replacement']) {
            const h = await harness();
            await h.begin();
            await h.finish('blocked original');
            if (when === 'during-delay') await h.advance(100);
            h.st.chat[h.st.chat.length - 1] = { ...h.st.chat.at(-1), mes: text };
            await h.advance(3000);
            assert.equal(h.calls.length, text.startsWith('blocked') ? 1 : 0);
            assert.equal(h.run, null);
        }
    });
}

for (const type of ['normal', 'regenerate']) {
    test(`does not rescan history when ${type} ends without a new reply`, async () => {
        const h = await harness({ chat: [{ is_user: true, mes: 'prompt' }, { is_user: false, mes: 'blocked history' }] });
        await h.begin(type);
        h.setFlag('is_send_press', false);
        await h.eventSource.emit(h.event_types.GENERATION_ENDED);
        await h.advance(3000);
        assert.equal(h.calls.length, 0);
        assert.equal(h.st.chat.at(-1).mes, 'blocked history');
        assert.equal(h.run, null);
    });
}

for (const phase of ['settling', 'waiting']) {
    test(`a stuck save times out safely while ${phase}`, async () => {
        const h = await harness();
        await h.begin();
        await h.finish('blocked response');
        if (phase === 'waiting') await h.advance(100);
        h.setFlag('isChatSaving', true);
        await h.advance(65_000);
        assert.equal(h.calls.length, 0);
        assert.equal(h.saves.length, 0);
        assert.equal(h.run, null);
        assert.equal(h.timers.size, 0);
        assert.equal(h.st.chat.at(-1).mes, 'blocked response');
        assert.ok(h.notices.some(notice => notice.args[0].includes('초과')));
    });
}

test('duplicate end events do not shorten the retry delay or start multiple regenerations', async () => {
    const h = await harness();
    await h.begin();
    await h.finish('blocked response');
    await h.advance(100);
    for (let i = 0; i < 3; i++) await h.eventSource.emit(h.event_types.GENERATION_ENDED);
    await h.advance(1400);
    assert.equal(h.calls.length, 0);
    await h.advance(200);
    assert.equal(h.calls.length, 1);
    await h.advance(5000);
    assert.equal(h.calls.length, 1);
});

test('native regenerate awaits its deletion handlers without a separate blacklist cleanup', async () => {
    const gate = deferred();
    let cleanups = 0;
    const h = await harness();
    h.eventSource.on(h.event_types.MESSAGE_DELETED, async () => { cleanups++; await gate.promise; });
    await h.begin();
    await h.finish('blocked response');
    await h.advance(2000);
    assert.equal(h.calls.length, 1);
    assert.equal(cleanups, 1);
    assert.equal(h.st.chat.length, 1);
    gate.resolve();
    await setImmediate();
    await h.advance(2000);
    assert.equal(h.st.chat.at(-1).mes, 'accepted');
    assert.equal(h.saves.length, 0);
});

test('failed regeneration leaves deletion and persistence to ST without deleting earlier replies', async () => {
    const prior = { is_user: false, mes: 'earlier valid reply' };
    const h = await harness({ chat: [{ is_user: true, mes: 'prompt' }, prior], responses: [new Error('network')] });
    await h.begin();
    await h.finish('blocked response');
    await h.advance(5000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.deletions.length, 1);
    assert.equal(h.st.chat.at(-1), prior);
    assert.equal(h.saves.length, 0);
    assert.equal(h.run, null);
    assert.equal(h.timers.size, 0);
    assert.equal(h.logEntries.length, 1);
    assert.equal(h.logEntries[0].level, 'warn');
    assert.ok(h.logEntries[0].args[0].includes('호스트 재생성 호출 실패'));
    assert.equal(h.logEntries[0].args[1].message, 'network');
});

test('install is idempotent', async () => {
    const h = await harness();
    h.feature.installGenerateBlacklistRetry();
    await h.begin();
    await h.finish('blocked');
    await h.advance(5000);
    assert.equal(h.calls.length, 1);
});

test('the existing request retry still replays only claimed generation requests', async () => {
    let attempts = 0;
    const h = await harness({ fetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify(attempts === 1 ? { error: 'temporary' } : { choices: [] }), {
            status: attempts === 1 ? 503 : 200, headers: { 'content-type': 'application/json' },
        });
    } });
    h.retry.installGenerateRetryFetchHook();
    await h.begin();
    const body = { type: 'normal', stream: false, messages: [] };
    await h.eventSource.emit(h.event_types.CHAT_COMPLETION_SETTINGS_READY, body);
    const response = h.context.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body) });
    await setImmediate();
    await h.advance(2000);
    assert.equal((await response).status, 200);
    assert.equal(attempts, 2);
});

for (const streaming of [false, true]) {
    test(`network, blacklist, network retries share one limit (${streaming ? 'streaming' : 'non-streaming'} completion)`, async () => {
        const h = await harness({
            apiResponses: [503, 'blocked', 429, 'accepted'],
            streamingRetries: streaming,
        });
        await h.begin();
        const run = h.run;
        const initial = h.requestReply().then(text => h.finish(text, { streaming }));
        await setImmediate();
        await h.advance(30_000);
        await initial;
        assert.equal(h.apiRequests.length, 4);
        assert.equal(h.calls.length, 1);
        assert.equal(run.retries, 3);
        assert.equal(h.st.chat.at(-1).mes, 'accepted');
        assert.equal(h.run, null);
        const retryNotices = h.notices.map(notice => notice.args[0]);
        for (const count of ['1/3', '2/3', '3/3']) {
            assert.equal(retryNotices.filter(message => message.includes(count)).length, 1);
        }
    });
}

for (const streaming of [false, true]) {
    test(`token-count dry runs do not interrupt native blacklist regeneration (streaming=${streaming})`, async () => {
        const h = await harness({ apiResponses: ['blocked', 503, 'accepted'], streamingRetries: streaming,
            settings: { generateRetryMaxRetries: 2 } });
        const countTokens = async () => {
            await h.begin('normal', {}, true);
            await h.eventSource.emit(h.event_types.GENERATE_AFTER_DATA, { prompt: 'count tokens' }, true);
        };
        // Insert a token count after preparation on every real API request,
        // including the native regenerate started by the blacklist check.
        h.eventSource.on(h.event_types.CHAT_COMPLETION_SETTINGS_READY, countTokens);
        await h.begin();
        const run = h.run;
        await h.finish(await h.requestReply(), { streaming });
        await h.advance(100);
        assert.equal(run.phase, 'waiting');
        await countTokens();
        assert.equal(h.run, run, 'a token count during the retry delay must not reset its budget');
        await h.advance(30_000);
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].type, 'regenerate');
        assert.equal(h.apiRequests.length, 3);
        assert.equal(run.retries, 2, 'blacklist and HTTP retries keep their shared allowance');
        assert.deepEqual(h.st.chat.map(m => m.mes), ['prompt', 'accepted']);
        assert.equal(h.run, null);
    });
}

test('blacklist, network, blacklist exhaustion keeps the final hit without granting another request', async () => {
    const h = await harness({ apiResponses: ['blocked initial', 503, 'blocked again', 'blocked final'] });
    await h.begin();
    const run = h.run;
    await h.finish(await h.requestReply());
    await h.advance(30_000);
    assert.equal(h.apiRequests.length, 4);
    assert.equal(h.calls.length, 2);
    assert.equal(run.retries, 3);
    assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'blocked final']);
    assert.equal(h.saves.length, 0);
    assert.equal(h.run, null);
});

for (const failure of [503, new TypeError('network offline'), { error: 'upstream failure' }]) {
    test(`request failures can use up the entire allowance before the first blacklist match (${typeof failure})`, async () => {
        const h = await harness({
            settings: { generateRetryMaxRetries: 2 },
            apiResponses: [failure, failure, 'blocked'],
        });
        await h.begin();
        const run = h.run;
        const initial = h.requestReply().then(text => h.finish(text));
        await setImmediate();
        await h.advance(30_000);
        await initial;
        assert.equal(run.retries, 2);
        assert.equal(h.apiRequests.length, 3);
        assert.equal(h.calls.length, 0);
        assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'blocked']);
        assert.equal(h.deletions.length, 0);
    });
}

test('a failed request after a blacklist retry receives only the remaining allowance', async () => {
    const h = await harness({
        settings: { generateRetryMaxRetries: 2 },
        apiResponses: ['blocked', 503, 503],
    });
    await h.begin();
    const run = h.run;
    await h.finish(await h.requestReply());
    await h.advance(30_000);
    assert.equal(h.apiRequests.length, 3);
    assert.equal(h.calls.length, 1);
    assert.equal(run.retries, 2);
    assert.equal(h.saves.length, 0);
    assert.equal(h.run, null);
});

test('a manually started new generation receives a fresh total allowance', async () => {
    const h = await harness({ apiResponses: [503, 'blocked', 429, 'accepted', 503, 503, 503, 'accepted again'] });
    await h.begin();
    const firstRun = h.run;
    let initial = h.requestReply().then(text => h.finish(text));
    await setImmediate();
    await h.advance(30_000);
    await initial;
    assert.equal(firstRun.retries, 3);

    h.st.chat.push({ is_user: true, mes: 'next prompt' });
    await h.begin();
    const nextRun = h.run;
    assert.notEqual(nextRun, firstRun);
    assert.equal(nextRun.retries, 0);
    initial = h.requestReply().then(text => h.finish(text));
    await setImmediate();
    await h.advance(30_000);
    await initial;
    assert.equal(nextRun.retries, 3);
    assert.equal(h.apiRequests.length, 8);
    assert.equal(h.st.chat.at(-1).mes, 'accepted again');
});

test('canceling a pending network retry does not spend its reserved-looking notice count', async () => {
    const h = await harness({ apiResponses: [503] });
    const controller = new AbortController();
    await h.begin();
    const run = h.run;
    const request = h.requestReply('normal', controller.signal);
    const rejected = assert.rejects(request);
    await setImmediate();
    controller.abort();
    await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
    await h.advance(5000);
    await rejected;
    assert.equal(run.retries, 0);
    assert.equal(h.apiRequests.length, 1);
});

test('blacklist retries use the common maximum even with request retries disabled', async () => {
    const h = await harness({
        settings: { generateRetryEnabled: false, generateRetryMaxRetries: 1 },
        apiResponses: ['blocked', 'blocked again'],
    });
    await h.begin();
    const run = h.run;
    await h.finish(await h.requestReply());
    await h.advance(5000);
    assert.equal(run.retries, 1);
    assert.equal(h.apiRequests.length, 2);
    assert.deepEqual(h.st.chat.map(message => message.mes), ['prompt', 'blocked again']);
    assert.equal(h.saves.length, 0);
});

test('request-only retries are still bounded when blacklist detection is disabled', async () => {
    const h = await harness({
        settings: { generateBlacklistRetryEnabled: false, generateRetryMaxRetries: 1 },
        apiResponses: [503, 503],
    });
    await h.begin();
    const rejected = assert.rejects(h.requestReply());
    await setImmediate();
    await h.advance(5000);
    await rejected;
    assert.equal(h.apiRequests.length, 2);
    assert.equal(h.calls.length, 0);
});

test('legacy blacklist maximum is removed while the common maximum is preserved', async () => {
    const persisted = { generateRetryMaxRetries: 2, generateBlacklistRetryMaxRetries: 9 };
    const context = vm.createContext({ URL });
    const { exports: state } = await loadModule('state.js', context, {
        '@sillytavern/script': { saveSettingsDebounced() {} },
        '@sillytavern/scripts/extensions': { extension_settings: { toolkit: persisted } },
        './constants.js': {
            SETTINGS_KEY: 'toolkit', EXTENSION_KEY: '__extension',
            SAVE_GENERATE_DEFAULT_ENABLED_MIGRATION_KEY: 'saveGenerateMigrated',
        },
    });
    state.initializeSettings();
    state.saveExtensionSettings();
    assert.equal(state.settings.generateRetryMaxRetries, 2);
    assert.equal(persisted.generateRetryMaxRetries, 2);
    assert.equal('generateBlacklistRetryMaxRetries' in state.settings, false);
    assert.equal('generateBlacklistRetryMaxRetries' in persisted, false);
});

// Representative proxy error only: never copy real prompts or proxy credentials.
const proxyErrorReply = `### **Proxy error (HTTP 503 Service Unavailable)**

The proxy encountered an error while trying to send your prompt to the API.

----
*Upstream service unavailable. Try again later.*

\`\`\`
{"error":{"code":503,"message":"Please try again later.","status":"UNAVAILABLE"}}
\`\`\`
<!-- oai-proxy-error -->`;

for (const mode of ['nonstream', 'stream', 'stream-error', 'stream-error-retained', 'user-stop', 'user-stop-retained']) {
    test(`proxy 503 blacklist: ${mode}`, async () => {
        const h = await harness({ settings: {
            generateBlacklistRetryText: 'Too Many Requests\nHTTP 503 Service Unavailable',
        } });
        await h.begin();
        await h.finish(proxyErrorReply, { streaming: mode !== 'nonstream', holdSave: true });
        if (mode.startsWith('stream-error') || mode.startsWith('user-stop')) {
            h.st.streamingProcessor.isStopped = true;
            h.st.streamingProcessor.isFinished = false;
            h.st.streamingProcessor.abortController.abort();
        }
        if (mode.startsWith('user-stop')) await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
        if (!mode.endsWith('-retained')) h.st.streamingProcessor = null;
        h.setFlag('isChatSaving', false);
        await h.advance(2000);
        assert.equal(h.calls.length, mode.startsWith('user-stop') ? 0 : 1);
        if (!mode.startsWith('user-stop')) assert.equal(h.st.chat.at(-1).mes, 'accepted');
    });
}

test('retained failed stream waits for chat save before blacklist retry', async () => {
    const h = await harness();
    await h.begin();
    await h.finish('blocked response', { streaming: true, holdSave: true });
    const processor = h.st.streamingProcessor;
    Object.assign(processor, { isStopped: true, isFinished: false });
    processor.abortController.abort();
    await h.advance(2000);
    assert.equal(h.run.phase, 'generating');
    assert.equal(h.calls.length, 0);
    assert.equal(h.deletions.length, 0);
    h.setFlag('isChatSaving', false);
    await h.advance(100);
    assert.equal(h.run.phase, 'waiting');
    assert.equal(h.st.streamingProcessor, processor);
    await h.advance(2000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.st.chat.at(-1).mes, 'accepted');
});

for (const phase of ['settling', 'waiting']) {
    test(`replacement stream blocks blacklist retry while ${phase}`, async () => {
        const h = await harness();
        await h.begin();
        await h.finish('blocked response', { streaming: true, holdSave: true });
        Object.assign(h.st.streamingProcessor, { isStopped: true, isFinished: false });
        h.st.streamingProcessor.abortController.abort();
        h.setFlag('isChatSaving', false);
        if (phase === 'waiting') {
            await h.advance(100);
            assert.equal(h.run.phase, 'waiting');
        }
        // Even another failed processor must not be mistaken for this run's stream.
        h.st.streamingProcessor = { ...h.st.streamingProcessor };
        await h.advance(2000);
        assert.equal(h.calls.length, 0);
        assert.equal(h.deletions.length, 0);
        assert.equal(h.st.chat.at(-1).mes, 'blocked response');
    });
}

test('blacklist native regenerate keeps prompt and reply contents out of the console', async () => {
    const h = await harness({ chat: [{ is_user: true, mes: 'PRIVATE_PROMPT_123' }], responses: ['PRIVATE_ACCEPTED_456'] });
    await h.begin();
    await h.finish('blocked PRIVATE_REPLY_789');
    await h.advance(2000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.st.chat.at(-1).mes, 'PRIVATE_ACCEPTED_456');
    assert.equal(h.run, null);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.logEntries, []);
});

test('blacklist wait polling is silent, uses one timer and warns once on timeout', async () => {
    const h = await harness();
    await h.begin();
    await h.finish('blocked', { streaming: true, holdSave: true });
    await h.advance(10_000);
    assert.deepEqual(h.logEntries, []);
    assert.equal(h.timers.size, 1);
    h.setFlag('isChatSaving', false);
    await h.advance(100);
    assert.deepEqual(h.logEntries, []);
    await h.advance(50_000);
    assert.equal(h.logEntries.length, 1);
    assert.equal(h.logEntries[0].level, 'warn');
    assert.ok(h.logEntries[0].args[0].includes('호스트 마무리 대기 시간 초과: streamingProcessor'));
    assert.equal(h.work.maxPendingTimers, 1);
    assert.equal(h.run, null);
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
    const fired = h.work.timersFired;
    await h.advance(60_000);
    assert.equal(h.work.timersFired, fired, 'timeout leaves no idle polling');
    assert.equal(h.logEntries.length, 1);
});

test('absent floor and explicit target-message cancellation leave no retry or timer', async () => {
    for (const mode of ['no-floor', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'GENERATION_STOPPED', 'CHAT_CHANGED']) {
        const h = await harness();
        await h.begin();
        if (mode === 'no-floor') {
            h.setFlag('is_send_press', false);
            await h.eventSource.emit(h.event_types.GENERATION_ENDED);
        } else {
            await h.finish('blocked');
            await h.eventSource.emit(h.event_types[mode], 1);
        }
        await h.advance(2000);
        assert.equal(h.calls.length, 0, mode);
        assert.equal(h.run, null, mode);
        assert.equal(h.timers.size, 0, mode);
        assert.deepEqual(h.logEntries, [], mode);
    }
});

test('blacklist skipped events and dry runs stay silent without scheduling checks', async () => {
    const h = await harness({ settings: { generateBlacklistRetryEnabled: false } });
    await h.begin();
    h.settings.generateBlacklistRetryEnabled = true;
    for (let floor = 0; floor < 100; floor++) await h.eventSource.emit(h.event_types.CHARACTER_MESSAGE_RENDERED, floor, 'normal');
    await h.eventSource.emit(h.event_types.GENERATION_ENDED);
    await h.begin();
    const run = h.run;
    await h.begin('normal', {}, true);
    assert.equal(h.run, run, 'dry run must preserve the active generation');
    await h.eventSource.emit(h.event_types.CHARACTER_MESSAGE_RENDERED, { mes: 'PRIVATE_EVENT_TEXT' }, 'normal');
    assert.deepEqual(h.logEntries, []);
    assert.equal(h.run.messageId, null);
    assert.equal(h.work.timersScheduled, 0);
});

test('blacklist uses the real extensions context API through start, render, retry and unlock', async () => {
    const h = await harness({ streamingRetries: true });
    await h.begin();
    assert.ok(h.run, 'GENERATION_AFTER_COMMANDS must establish the blacklist run');
    await h.finish('blocked response', { streaming: true, holdSave: true });
    await h.advance(500);
    assert.equal(h.calls.length, 0, 'wait until native saving and streaming settle');
    h.setFlag('isChatSaving', false);
    h.st.streamingProcessor = null;
    await h.advance(2000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].type, 'regenerate');
    assert.equal(h.st.chat.at(-1).mes, 'accepted');
    assert.equal(h.run, null);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.logEntries, []);

    const cancelled = await harness();
    await cancelled.begin();
    await cancelled.finish('blocked');
    await cancelled.advance(100);
    assert.equal(cancelled.run.uiLocked, true);
    await cancelled.eventSource.emit(cancelled.event_types.GENERATION_STOPPED);
    assert.equal(cancelled.run, null, 'cancelling a pending retry also uses the real context API to unlock');
    assert.equal(cancelled.timers.size, 0);
    assert.equal(cancelled.calls.length, 0);
});


for (const streaming of [false, true]) {
    for (const soundFirst of [false, true]) {
        test(`completion sound waits for final acceptance (streaming=${streaming}, soundFirst=${soundFirst})`, async () => {
            const h = await harness({ streamingRetries: streaming, soundFirst,
                settings: { messageCompletionSoundEnabled: true } });
            await h.advance(1000); // The real clock is past the audio cooldown's zero baseline.
            await h.begin();
            await h.finish('blocked', { streaming });
            await h.advance(100);
            assert.equal(h.run.phase, 'waiting');
            assert.equal(h.soundPlays.length, 0, 'a reply scheduled for retry must not ring');
            await h.advance(1500);
            assert.equal(h.calls.length, 1);
            assert.equal(h.soundPlays.length, 0, 'the retry also waits for its own blacklist check');
            await h.advance(100);
            assert.equal(h.run, null);
            assert.equal(h.soundPlays.length, 1);
            await h.eventSource.emit(h.event_types.GENERATION_ENDED);
            await h.advance(3000);
            assert.equal(h.soundPlays.length, 1, 'repeated end events must not replay the notification');
        });
    }
    test(`completion sound rings once on an exhausted blacklist budget (streaming=${streaming})`, async () => {
        const h = await harness({ responses: ['blocked again', 'still blocked'], streamingRetries: streaming,
            settings: { messageCompletionSoundEnabled: true, generateRetryMaxRetries: 2 } });
        await h.advance(1000);
        await h.begin();
        await h.finish('blocked', { streaming });
        await h.advance(1700);
        assert.equal(h.calls.length, 1);
        assert.equal(h.soundPlays.length, 0);
        await h.advance(1600);
        assert.equal(h.calls.length, 2);
        assert.equal(h.run, null);
        assert.equal(h.st.chat.at(-1).mes, 'still blocked');
        assert.equal(h.soundPlays.length, 1);
    });
}

for (const mode of ['disabled', 'empty', 'accepted']) {
    test(`completion sound keeps normal completion behavior: ${mode}`, async () => {
        const h = await harness({ settings: { messageCompletionSoundEnabled: true } });
        if (mode === 'disabled') h.settings.generateBlacklistRetryEnabled = false;
        if (mode === 'empty') h.settings.generateBlacklistRetryText = '';
        await h.advance(1000);
        await h.begin();
        await h.finish(mode === 'accepted' ? 'accepted' : 'blocked');
        await h.advance(200);
        assert.equal(h.calls.length, 0);
        assert.equal(h.soundPlays.length, 1);
    });
}

for (const mode of ['off', 'disable-while-waiting', 'disable-before-final-check']) {
    test(`completion sound never auto-plays when disabled: ${mode}`, async () => {
        const h = await harness({ settings: { messageCompletionSoundEnabled: mode !== 'off' } });
        await h.advance(1000);
        await h.begin();
        await h.finish('blocked');
        await h.advance(100);
        if (mode === 'disable-before-final-check') await h.advance(1500);
        h.settings.messageCompletionSoundEnabled = false;
        h.sound.applyMessageCompletionSound();
        await h.advance(4000);
        assert.equal(h.calls.length, 1, 'disabling sound must not cancel blacklist retries');
        assert.equal(h.run, null);
        assert.equal(h.soundPlays.length, 0);
        // Re-enabling does not play the old result or leave duplicate listeners.
        h.settings.messageCompletionSoundEnabled = true;
        h.sound.applyMessageCompletionSound();
        h.sound.applyMessageCompletionSound();
        await h.eventSource.emit(h.event_types.GENERATION_ENDED);
        await h.advance(100);
        assert.equal(h.soundPlays.length, 0);
        await h.begin('regenerate');
        await h.st.deleteLastMessage();
        await h.finish('accepted new generation');
        await h.advance(100);
        assert.equal(h.soundPlays.length, 1);
    });
}

test('completion sound also stays silent at the retry limit when its switch is off', async () => {
    const h = await harness({ responses: ['blocked'], settings: { generateRetryMaxRetries: 1 } });
    await h.advance(1000);
    await h.begin();
    await h.finish('blocked');
    await h.advance(4000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.run, null);
    assert.equal(h.soundPlays.length, 0);
});

for (const event of ['GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_UPDATED']) {
    for (const soundFirst of [false, true]) {
        test(`completion sound discards a cancelled retry: ${event}, soundFirst=${soundFirst}`, async () => {
            const h = await harness({ soundFirst, settings: { messageCompletionSoundEnabled: true } });
            await h.advance(1000);
            await h.begin();
            await h.finish('blocked');
            await h.advance(100);
            await h.eventSource.emit(h.event_types[event], h.st.chat.length - 1);
            await h.eventSource.emit(h.event_types.GENERATION_ENDED);
            await h.advance(4000);
            assert.equal(h.run, null);
            assert.equal(h.calls.length, 0);
            assert.equal(h.soundPlays.length, 0, 'cancelling must not turn button-unlock end events into a completion');
            assert.equal(h.extensionState.messageCompletionSound.waitingForBlacklist, false);
        });
    }
}

for (const soundFirst of [false, true]) {
    test(`completion sound belongs to the new manual generation, not the cancelled chain (soundFirst=${soundFirst})`, async () => {
        const h = await harness({ soundFirst, settings: { messageCompletionSoundEnabled: true } });
        await h.advance(1000);
        await h.begin();
        await h.finish('blocked');
        await h.advance(100);
        await h.begin('regenerate');
        await h.st.deleteLastMessage();
        await h.finish('accepted manual retry');
        await h.advance(200);
        assert.equal(h.calls.length, 0);
        assert.equal(h.soundPlays.length, 1);
    });
}

test('completion sound waits for stream/save cleanup and preserves pending notification across dry runs', async () => {
    const h = await harness({ settings: { messageCompletionSoundEnabled: true } });
    await h.advance(1000);
    await h.begin();
    await h.finish('accepted', { streaming: true, holdSave: true });
    await h.advance(2500);
    assert.equal(h.soundPlays.length, 0);
    await h.begin('normal', {}, true);
    h.setFlag('isChatSaving', false);
    h.st.streamingProcessor = null;
    await h.advance(100);
    assert.equal(h.soundPlays.length, 1);
});

test('completion sound never treats a dry run or a manually stopped generation as completion', async () => {
    const h = await harness({ settings: { messageCompletionSoundEnabled: true } });
    await h.advance(1000);
    await h.begin('normal', {}, true);
    await h.eventSource.emit(h.event_types.GENERATION_ENDED);
    await h.advance(100);
    assert.equal(h.soundPlays.length, 0);
    await h.begin();
    await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
    await h.finish('accepted partial reply');
    await h.advance(2000);
    assert.equal(h.soundPlays.length, 0);
});

test('completion sound handles exhausted shared HTTP/blacklist budget', async () => {
    const h = await harness({ apiResponses: [503, 'blocked'],
        settings: { messageCompletionSoundEnabled: true, generateRetryMaxRetries: 1 } });
    await h.advance(1000);
    await h.begin();
    const pending = h.requestReply();
    await setImmediate(); // Let the mocked fetch schedule its retry before advancing the clock.
    await h.advance(3000);
    await h.finish(await pending);
    assert.equal(h.soundPlays.length, 0);
    await h.advance(100);
    assert.equal(h.calls.length, 0, 'HTTP retries already spent the shared budget');
    assert.equal(h.run, null);
    assert.equal(h.soundPlays.length, 1);
});

test('completion sound rechecks its switch after async audio loading, while explicit preview still works', async () => {
    const h = await harness({ settings: { messageCompletionSoundEnabled: true } });
    await h.advance(1000);
    const pending = h.sound.playSelectedMessageCompletionSound();
    h.settings.messageCompletionSoundEnabled = false;
    h.sound.applyMessageCompletionSound();
    assert.equal(await pending, false);
    assert.equal(h.soundPlays.length, 0);
    assert.equal(await h.sound.playSelectedMessageCompletionSound({ preview: true }), true);
    assert.equal(h.soundPlays.length, 1);
});

for (const outcome of ['accepted', 'stopped', 'disabled', 'timeout']) {
    test(`mobile silent keep-alive survives blacklist waiting and is cleaned up: ${outcome}`, async () => {
        const h = await harness({ mobile: true, settings: { messageCompletionSoundEnabled: true } });
        await h.advance(1000);
        await h.begin();
        await h.finish('blocked', { holdSave: outcome === 'timeout' });
        await h.advance(100);
        const state = h.extensionState.messageCompletionSound;
        assert.equal(state.keepAlivePlaying, true);
        assert.equal(state.keepAliveAudio.paused, false);
        assert.equal(h.soundPlays.length, 0);
        if (outcome === 'stopped') await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
        if (outcome === 'disabled') {
            h.settings.messageCompletionSoundEnabled = false;
            h.sound.applyMessageCompletionSound();
        }
        await h.advance(outcome === 'timeout' ? 60_000 : 4000);
        assert.equal(state.keepAlivePlaying, false);
        assert.equal(state.keepAliveRequested, false);
        assert.equal(state.keepAliveAudio.paused, true);
        assert.equal(h.soundPlays.length, outcome === 'accepted' ? 1 : 0);
    });
}


test('normal retry and completion sound run without process diagnostics', async () => {
    const h = await harness({ settings: { messageCompletionSoundEnabled: true } });
    await h.advance(1000);
    await h.begin();
    await h.finish('blocked');
    await h.advance(2000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.soundPlays.length, 1);
    assert.deepEqual(h.logEntries, [], 'routine paths must not log, including at Verbose level');
});

test('disabled blacklist avoids reading settings text or constructing a chat context', async () => {
    const h = await harness({ settings: { generateBlacklistRetryEnabled: false } });
    Object.defineProperty(h.settings, 'generateBlacklistRetryText', {
        get() { assert.fail('disabled blacklist must not parse its text'); },
    });
    await h.begin();
    await h.finish('accepted');
    await h.advance(1000);
    assert.equal(h.work.contextReads, 0);
    assert.equal(h.work.timersScheduled, 0);
    assert.equal(h.run, null);
});


test('repeated blacklist install and sound toggles never accumulate event listeners', async () => {
    const h = await harness();
    const events = [...Object.values(h.event_types), GENERATE_BLACKLIST_SETTLED_EVENT];
    const counts = () => events.map(event => h.eventSource.listenerCount(event));
    const disabled = counts();
    h.settings.messageCompletionSoundEnabled = true;
    h.sound.applyMessageCompletionSound();
    const enabled = counts();
    assert.equal(h.eventSource.listenerCount(GENERATE_BLACKLIST_SETTLED_EVENT), 1);
    for (let i = 0; i < 100; i++) {
        h.feature.installGenerateBlacklistRetry();
        h.sound.applyMessageCompletionSound();
        assert.deepEqual(counts(), enabled);
        h.settings.messageCompletionSoundEnabled = false;
        h.sound.applyMessageCompletionSound();
        assert.deepEqual(counts(), disabled);
        h.settings.messageCompletionSoundEnabled = true;
        h.sound.applyMessageCompletionSound();
        assert.deepEqual(counts(), enabled);
    }
    assert.equal(h.work.timersScheduled, 0);
    await h.advance(1000);
    await h.begin();
    await h.finish('accepted');
    await h.advance(200);
    assert.equal(h.soundPlays.length, 1);
    assert.equal(h.timers.size, 0);
});

test('repeated completion, retry and cancellation cycles leave no background work', async () => {
    const h = await harness({ settings: { messageCompletionSoundEnabled: true } });
    const events = [...Object.values(h.event_types), GENERATE_BLACKLIST_SETTLED_EVENT];
    const counts = events.map(event => h.eventSource.listenerCount(event));
    for (let i = 0; i < 90; i++) {
        await h.advance(1000);
        await h.begin();
        await h.finish(i % 3 === 0 ? 'accepted' : 'blocked');
        if (i % 3 === 2) {
            await h.advance(100);
            await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
        }
        await h.advance(2000);
        assert.equal(h.run, null);
        assert.equal(h.extensionState.generateBlacklistRetry.timer, null);
        assert.equal(h.timers.size, 0);
        assert.deepEqual(events.map(event => h.eventSource.listenerCount(event)), counts);
    }
    assert.equal(h.calls.length, 30);
    assert.equal(h.soundPlays.length, 60);
    assert.equal(h.work.maxPendingTimers, 1);
    const work = { ...h.work };
    await h.advance(600_000);
    assert.deepEqual(h.work, work, 'nothing runs after the last cycle finishes');
    assert.deepEqual(h.logEntries, []);
});

test('idle render and end event bursts do not construct contexts or schedule timers', async () => {
    const h = await harness({ settings: { messageCompletionSoundEnabled: true } });
    for (let floor = 0; floor < 2000; floor++) {
        await h.eventSource.emit(h.event_types.CHARACTER_MESSAGE_RENDERED, floor, 'normal');
        await h.eventSource.emit(h.event_types.GENERATION_ENDED);
    }
    assert.equal(h.work.contextReads, 0);
    assert.equal(h.work.timersScheduled, 0);
    assert.equal(h.soundPlays.length, 0);
    assert.deepEqual(h.logEntries, []);
});

test('blacklist scans only the latest generated body, never historical messages', async () => {
    const chat = Array.from({ length: 10_000 }, () => ({
        is_user: true,
        get mes() { throw new Error('historical body must not be scanned'); },
    }));
    const h = await harness({ chat, settings: { messageCompletionSoundEnabled: true } });
    await h.advance(1000);
    await h.begin();
    await h.finish('accepted');
    await h.advance(200);
    assert.equal(h.calls.length, 0);
    assert.equal(h.soundPlays.length, 1);
    assert.equal(h.run, null);
    assert.equal(h.timers.size, 0);
    assert.equal(h.work.timersFired, 1);
    assert.deepEqual(h.logEntries, []);
});
