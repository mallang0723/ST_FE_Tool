import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROOT, ApiError, CONFIG_DEFAULTS, PACKAGE_VERSION, PROTOCOL_VERSION, requireValue } from '../shared/contracts/index.mjs';
import { changeDocument, readDocument, safeFile, userStore, serialized } from './storage/documents.mjs';
import { getLibrary, putLibrary } from './services/library.mjs';
import { Backups } from './services/backups.mjs';
import { FileCache } from './services/cache.mjs';
import { JobManager } from './jobs/manager.mjs';
import { createHostAdapter } from './host-adapter/index.mjs';
import { getConfig, uiEnabled } from './services/config.mjs';

export const info = { id: 'st-ko-tools', name: '담소 도구함', description: '한국어 편의 기능과 사용자별 저장·생성 서비스' };
let jobs;
export async function init(router, options = {}) {
    const host = options.host || await createHostAdapter();
    jobs = new JobManager(host);
    const backups = new Backups(); const cache = new FileCache();
    const route = (method, endpoint, fn, raw = false) => router[method](`/v1${endpoint}`, async (req, res) => {
        try {
            await userStore(req.user);
            res.setHeader('Cache-Control', 'no-store');
            const data = await fn(req, res);
            if (!res.headersSent) res.json(raw ? data : { ok: true, data });
        } catch (error) {
            if (!res.headersSent) res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : '요청을 처리하지 못했습니다.', retryable: !error.status || error.status >= 500, ...error.details } });
        }
    });
    route('get', '/status', async req => ({
        protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION,
        host: { supported: host.supported, version: host.version }, storage: { ready: Boolean(await userStore(req.user)) },
        capabilities: { promptLibrary: true, presetBackups: true, chatLists: true, settingsBootstrap: true, extensionBundle: true, lazyThemes: true, tokenizerBulk: true,
            backgroundJobs: host.supported, backgroundJobSources: host.supported ? ['openai','custom'] : [], backgroundJobTypes: ['normal','regenerate'], completeResponseTool: true, n: 1 },
    }));
    route('get', '/config', async req => ({...await getConfig(req.user),uiEnabled:await uiEnabled(req.user)}));
    route('put', '/config', req => changeDocument(req.user, 'config', CONFIG_DEFAULTS, req.body.expectedRevision, current => {
        for (const key of Object.keys(CONFIG_DEFAULTS)) {
            if (req.body[key] === undefined) continue;
            requireValue(typeof req.body[key] === typeof CONFIG_DEFAULTS[key]); current[key] = req.body[key];
        }
        requireValue(Number.isSafeInteger(current.backupKeepCount) && current.backupKeepCount >= 1 && current.backupKeepCount <= 100000);
        current.progressiveChatLoadingEnabled = false;
        if (!current.settingsAccelerationEnabled) current.lazyThemeLoadingEnabled = false;
        cache.clear(req.user); return current;
    }));
    route('get', '/prompt-library', req => getLibrary(req.user));
    route('put', '/prompt-library', req => putLibrary(req.user, req.body));
    route('post', '/preset-backups', req => backups.create(req.user, req.body));
    route('post', '/preset-backups/list', req => backups.list(req.user));
    route('post', '/preset-backups/get', req => backups.get(req.user, req.body.fileName));
    route('post', '/preset-backups/rename', req => { requireValue(typeof req.body.showName === 'string' && req.body.showName.trim().length > 0 && req.body.showName.length < 300); return backups.mutate(req.user, req.body.fileName, { showName: req.body.showName, name: req.body.showName }, req.body.expectedRevision); });
    route('post', '/preset-backups/note', req => { requireValue(typeof req.body.note === 'string' && req.body.note.length <= 10000); return backups.mutate(req.user, req.body.fileName, { note: req.body.note }, req.body.expectedRevision); });
    route('post', '/preset-backups/delete', req => backups.mutate(req.user, req.body.fileName, 'delete', req.body.expectedRevision));
    route('post', '/preset-backups/prune', async req => serialized(await backups.directory(req.user), async () => {
        const config = await readDocument(req.user, 'config', CONFIG_DEFAULTS);
        requireValue(config.backupAutoCleanupEnabled && req.body.expectedRevision === config.revision, '정리 설정을 다시 확인해 주세요.');
        await backups.prune(req.user, config.backupKeepCount); return backups.list(req.user);
    }));
    const nativeCached = (kind, endpoint, dirs) => req => cache.get(req.user, kind + endpoint + JSON.stringify(req.body || {}), dirs(req.user), () => host.request(kind, endpoint, req.user, req.body));
    const chatDirs = u => [u.directories.chats, u.directories.groupChats, u.directories.groups, u.directories.characters];
    route('post', '/chats/search', nativeCached('chats', '/search', chatDirs), true);
    route('post', '/chats/recent', nativeCached('chats', '/recent', chatDirs), true);
    route('get', '/chats/recent', nativeCached('chats', '/recent', chatDirs), true);
    route('post', '/chat-backups/list', nativeCached('backups', '/chat/get', u => [u.directories.backups]), true);
    route('post', '/characters/list', nativeCached('characters', '/all', u => [u.directories.characters]), true);
    route('post', '/chats/get', req => host.coordinator.withChatWrite(req.user, async () => {
        const file = host.coordinator.chatPath(req.user, req.body);
        return { chat: await jobs.readChat(file), revision: host.coordinator.fileRevision(file) };
    }));
    route('post', '/bootstrap/settings', async req => {
        const dirs = ['root','novelAI_Settings','openAI_Settings','textGen_Settings','koboldAI_Settings','worlds','themes','movingUI','quickreplies','instruct','context','sysprompt','reasoning'];
        const data = await cache.get(req.user, 'settings', dirs.map(k => k === 'root' ? path.join(req.user.directories.root,'settings.json') : req.user.directories[k]).filter(Boolean), () => host.request('settings','/get',req.user));
        const config = await readDocument(req.user, 'config', CONFIG_DEFAULTS);
        if (config.lazyThemeLoadingEnabled && config.settingsAccelerationEnabled) {
            const settings = JSON.parse(data.settings);
            const active = settings.power_user?.theme;
            data.themes = data.themes.map(theme => theme.name === active ? theme : { name: theme.name, damsoLazy: true });
        }
        return data;
    }, true);
    route('post', '/themes/get', async req => {
        requireValue(typeof req.body.name === 'string' && !/[/\\\0]/.test(req.body.name));
        return JSON.parse(await fs.readFile(await safeFile(req.user.directories.themes, `${req.body.name}.json`), 'utf8'));
    });
    route('get', '/extensions/bundle', async req => {
        const entries = await host.request('extensions','/discover',req.user,{}, {}, 'GET');
        const manifests = {};
        for (const entry of entries) {
            const root = entry.type === 'local' ? req.user.directories.extensions : path.join(host.root,'public/scripts/extensions', entry.type === 'global' ? 'third-party' : '');
            const name = entry.type === 'system' ? entry.name : entry.name.replace(/^third-party\//, '');
            manifests[entry.name] = JSON.parse(await fs.readFile(await safeFile(root, `${name}/manifest.json`), 'utf8'));
        }
        return { entries, manifests };
    });
    route('post', '/tokenizers/bulk-count', async req => {
        const items = req.body.items;
        requireValue(Array.isArray(items) && items.length <= 512);
        const counts = [];
        for (const item of items) {
            requireValue(typeof item.id === 'string' && typeof item.model === 'string' && Array.isArray(item.messages));
            const result = await host.request('tokenizers', '/openai/count', req.user, item.messages, { model: item.model });
            requireValue(Number.isFinite(result?.token_count)); counts.push({ id: item.id, count: result.token_count });
        }
        return { counts };
    });
    route('post', '/jobs', req => { requireValue(host.supported, '호스트 연결을 먼저 설치해 주세요.'); return jobs.submit(req.user, req.body); });
    route('get', '/jobs', req => jobs.list(req.user));
    route('get', '/jobs/:id', req => jobs.get(req.user, req.params.id));
    route('post', '/jobs/:id/cancel', req => jobs.cancel(req.user, req.params.id));
    route('get', '/assets/early-bridge.js', async (req,res) => {
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'early-bridge.js');
        res.type('application/javascript').send(await fs.readFile(file, 'utf8'));
    });
    return { host, jobs, backups, cache, apiRoot: API_ROOT };
}
export async function exit() { await jobs?.stop(); }
