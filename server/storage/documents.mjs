import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, requireValue } from '../../shared/contracts/index.mjs';

const queues = new Map();
export async function serialized(key, action) {
    const previous = queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    queues.set(key, current);
    try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}
export async function atomicJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temp, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(data));
        await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temp, file);
        const dir = await fs.open(path.dirname(file), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
    } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
}
export async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}
export async function userStore(user) {
    if (!user?.directories?.root || !user?.profile?.handle) throw new ApiError(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
    const root = await fs.realpath(user.directories.root);
    const store = path.join(root, 'st-ko-tools');
    await fs.mkdir(store, { recursive: true, mode: 0o700 });
    if (await fs.realpath(store) !== store) throw new ApiError(400, 'INVALID_PATH', '저장 경로를 확인해 주세요.');
    return store;
}
export async function readDocument(user, name, defaults) {
    const file = path.join(await userStore(user), `${name}.json`);
    const doc = await readJson(file, { schemaVersion: 1, revision: 0, ...defaults });
    if (doc.schemaVersion !== 1 || !Number.isSafeInteger(doc.revision)) throw new ApiError(503, 'INVALID_STORAGE', '저장소 형식을 확인해 주세요.');
    return doc;
}
export async function changeDocument(user, name, defaults, expectedRevision, transform) {
    const file = path.join(await userStore(user), `${name}.json`);
    return serialized(file, async () => {
        const current = await readDocument(user, name, defaults);
        requireValue(Number.isSafeInteger(expectedRevision), 'expectedRevision이 필요합니다.');
        if (current.revision !== expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', '다른 창에서 변경되었습니다. 다시 불러와 주세요.', { revision: current.revision });
        const next = { ...await transform(structuredClone(current)), schemaVersion: 1, revision: current.revision + 1 };
        await atomicJson(file, next); return next;
    });
}
export async function safeFile(root, relative) {
    requireValue(typeof relative === 'string' && relative.length > 0 && !relative.includes('\0'));
    const base = await fs.realpath(root);
    const file = path.resolve(base, relative);
    requireValue(file.startsWith(base + path.sep), '허용되지 않은 파일 경로입니다.');
    // Check every existing component, including symlinks, before reading or writing.
    let parent = file;
    while (parent !== base) {
        try {
            const resolved = await fs.realpath(parent);
            requireValue(resolved === base || resolved.startsWith(base + path.sep), '허용되지 않은 파일 경로입니다.');
            break;
        } catch (error) { if (error.code !== 'ENOENT') throw error; parent = path.dirname(parent); }
    }
    return file;
}
