import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ApiError, HOST_VERSIONS } from '../../shared/contracts/index.mjs';

export async function createHostAdapter(root = process.cwd()) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'sillytavern' || !HOST_VERSIONS.includes(pkg.version)) throw new Error('Unsupported SillyTavern version');
    const module = file => import(pathToFileURL(path.join(root, 'src', file)).href);
    const [chats, generation, coordinator, tokenizers, settings, extensions, characters, backups] = await Promise.all([
        module('endpoints/chats.js'), module('endpoints/backends/chat-completions.js'), module('damso-chat-coordinator.mjs'),
        module('endpoints/tokenizers.js'), module('endpoints/settings.js'), module('endpoints/extensions.js'),
        module('endpoints/characters.js'), module('endpoints/backups.js'),
    ]);
    const routers = { chats, tokenizers, settings, extensions, characters, backups };
    return {
        root, version: pkg.version, coordinator,
        supported: coordinator.coordinationInstalled() && typeof generation.damsoGenerate === 'function',
        async request(kind, route, user, body = {}, query = {}, method = 'POST') {
            const router = routers[kind]?.router;
            if (!router) throw new ApiError(501, 'UNSUPPORTED', '지원하지 않는 호스트 기능입니다.');
            // Use the actual native route handlers, preserving validation, payloads and model rules.
            const layer = router.stack.find(layer => layer.route?.path === route && layer.route.methods[method.toLowerCase()]);
            if (!layer) throw new ApiError(501, 'UNSUPPORTED', '호스트 경로를 찾을 수 없습니다.');
            return invokeHandlers(layer.route.stack.map(s => s.handle), user, body, query);
        },
        async generate(user, body, signal) {
            const result = await invokeHandlers([generation.damsoGenerate], user, { ...structuredClone(body), stream: false }, {}, signal, true);
            if (result?.error) throw new ApiError(502, 'GENERATION_FAILED', '모델 요청에 실패했습니다.');
            return result;
        },
        async save(user, file, chat, avatar) {
            await chats.trySaveChat(chat, file, false, user.profile.handle, avatar.replace('.png',''), user.directories.backups);
        },
    };
}

export function invokeHandlers(handlers, user, body, query = {}, signal, background = false) {
    return new Promise((resolve, reject) => {
        const socket = new EventEmitter();
        const req = Object.assign(new EventEmitter(), { user, body: structuredClone(body), query, headers: {}, socket, damsoBackground: background });
        const res = Object.assign(new EventEmitter(), {
            statusCode: 200, headersSent: false, writableEnded: false,
            status(code) { this.statusCode = code; return this; },
            setHeader() { return this; }, header() { return this; }, set() { return this; },
            send(data) {
                this.headersSent = true; this.writableEnded = true;
                signal?.removeEventListener('abort', abort);
                if (this.statusCode >= 400) reject(new ApiError(this.statusCode, 'HOST_ERROR', '호스트 요청에 실패했습니다.'));
                else resolve(data);
                this.emit('finish'); return this;
            },
            json(data) { return this.send(data); }, sendStatus(code) { return this.status(code).send(null); },
            end(data) { return this.send(data); },
        });
        const abort = () => { socket.emit('close'); reject(new ApiError(499, 'CANCELED', '생성을 중단했습니다.')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        let index = 0;
        const next = error => {
            if (error) return reject(error);
            const handler = handlers[index++];
            if (!handler) return reject(new Error('Host route did not respond'));
            try { Promise.resolve(handler(req, res, next)).catch(reject); } catch (error) { reject(error); }
        };
        next();
    });
}
