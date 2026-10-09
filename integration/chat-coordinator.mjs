import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// This module is imported by both the native chat router and the server plugin.
const state = globalThis[Symbol.for('damso.chat.coordinator')] ||= { queues: new Map(), installed: false };
export function fileRevision(file) {
    try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
}
export async function withChatWrite(user, action) {
    const key = fs.realpathSync(user.directories.root);
    const previous = state.queues.get(key) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => held);
    state.queues.set(key, queued);
    await previous.catch(() => {});
    try { return await action(); } finally { release(); if (state.queues.get(key) === queued) state.queues.delete(key); }
}
export function chatPath(user, body, operation = '/get') {
    const group = operation.startsWith('/group/') || body.is_group;
    const root = group ? user.directories.groupChats : user.directories.chats;
    const avatar = String(body.avatar_url || '').replace('.png', '');
    let name = operation.endsWith('/rename') ? body.original_file : operation.endsWith('/delete') ? body.chatfile ?? body.id : body.file_name ?? body.id;
    if (!name || (!group && (!avatar || /[/\\\0]/.test(avatar)))) throw new Error('Invalid chat target');
    name = String(name);
    if (/[/\\\0]/.test(name) || name === '.' || name === '..') throw new Error('Invalid chat target');
    if (!name.endsWith('.jsonl')) name += '.jsonl';
    const base = fs.realpathSync(root);
    const file = path.resolve(base, group ? '' : avatar, name);
    if (!file.startsWith(base + path.sep)) throw new Error('Invalid chat target');
    let parent = file;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const real = fs.realpathSync(parent);
    if (real !== base && !real.startsWith(base + path.sep)) throw new Error('Invalid chat target');
    return file;
}
export function installChatCoordination(router) {
    state.installed = true;
    router.use((req, res, next) => {
        const operation = req.path;
        if (!['/get','/save','/delete','/rename','/group/get','/group/save','/group/delete'].includes(operation)) return next();
        void withChatWrite(req.user, async () => {
            let file;
            try { file = chatPath(req.user, req.body, operation); }
            catch { return res.status(400).send({ error: 'Invalid chat target' }); }
            const current = fileRevision(file);
            const expected = req.headers['x-damso-revision'];
            if (!operation.endsWith('/get') && current !== 'missing' && !expected) {
                return res.status(428).send({ error: 'revision_required', message: 'Reload this chat before saving.' });
            }
            if (!operation.endsWith('/get') && expected && expected !== current) {
                return res.status(409).send({ error: 'revision_conflict', revision: current });
            }
            const send = res.send;
            let responded;
            res.send = function (body) {
                this.setHeader('x-damso-revision', fileRevision(file));
                try { return send.call(this, body); } finally { responded?.(); }
            };
            await new Promise((resolve, reject) => {
                // Native handlers send only after the write settles. A disconnected client
                // may never emit finish, so also release after that response attempt.
                responded = resolve;
                res.once('finish', resolve);
                try { next(); } catch (error) { reject(error); }
            });
        }).catch(next);
    });
}
export function coordinationInstalled() { return state.installed; }
