import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function fingerprint(root, hash) {
    try {
        const rootStat = await fs.stat(root);
        if (rootStat.isFile()) { hash.update(`${root}:${rootStat.size}:${rootStat.mtimeMs}:${rootStat.ctimeMs}`); return; }
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
            const file = path.join(root, entry.name);
            if (entry.isDirectory()) await fingerprint(file, hash);
            else { const s = await fs.stat(file); hash.update(`${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`); }
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('missing'); }
}
export class FileCache {
    entries = new Map();
    async get(user, key, directories, compute) {
        const hash = createHash('sha256');
        for (const dir of directories) await fingerprint(dir, hash);
        const revision = hash.digest('hex');
        const id = `${user.directories.root}:${key}`;
        const found = this.entries.get(id);
        if (found?.revision === revision) return structuredClone(found.value);
        const value = await compute();
        this.entries.set(id, { revision, value: structuredClone(value) });
        if (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value);
        return value;
    }
    clear(user) { for (const key of this.entries.keys()) if (key.startsWith(user.directories.root + ':')) this.entries.delete(key); }
}
