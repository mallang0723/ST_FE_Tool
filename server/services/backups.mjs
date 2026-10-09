import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, serialized, userStore } from '../storage/documents.mjs';
import { ApiError, requireValue } from '../../shared/contracts/index.mjs';
import { getConfig } from './config.mjs';

export class Backups {
    async directory(user) { const dir = path.join(await userStore(user), 'preset-backups'); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); return dir; }
    async file(user, id) { requireValue(typeof id === 'string' && /^[a-f0-9-]{36}\.json$/.test(id)); return path.join(await this.directory(user), id); }
    async records(user) {
        const dir = await this.directory(user);
        const files = (await fs.readdir(dir)).filter(x => x.endsWith('.json'));
        const records = await Promise.all(files.map(async f => {
            const doc = await readJson(path.join(dir, f));
            if (doc?.schemaVersion !== 1 || doc.fileName !== f || typeof doc.note !== 'string' || !Number.isFinite(doc.createdAtMs)) throw new ApiError(503, 'INVALID_BACKUP', '백업 메타데이터를 확인해 주세요. 정리를 중단했습니다.');
            return doc;
        }));
        return records.sort((a,b) => b.createdAtMs - a.createdAtMs || b.fileName.localeCompare(a.fileName));
    }
    async list(user) { return { items: (await this.records(user)).map(({ body, ...meta }) => meta) }; }
    async get(user, id) {
        const doc = await readJson(await this.file(user, id), null);
        if (!doc) throw new ApiError(404, 'NOT_FOUND', '백업을 찾을 수 없습니다.'); return doc;
    }
    async create(user, body) {
        requireValue(body?.preset && typeof body.preset === 'object' && !Array.isArray(body.preset) && typeof body.name === 'string');
        return serialized(await this.directory(user), async () => {
            const fileName = `${randomUUID()}.json`;
            const createdAtMs = Date.now();
            const doc = { schemaVersion: 1, revision: 1, fileName, name: body.name, showName: body.name, note: '', createdAtMs, createdAt: new Date(createdAtMs).toISOString(), body };
            await atomicJson(await this.file(user, fileName), doc);
            const config = await getConfig(user);
            if (config.backupAutoCleanupEnabled !== false) await this.prune(user, config.backupKeepCount ?? 200);
            return doc;
        });
    }
    async prune(user, count) {
        requireValue(Number.isSafeInteger(count) && count >= 1);
        // Validate the entire list before deleting anything. Protected backups do not count.
        const ordinary = (await this.records(user)).filter(x => !x.note.trim());
        for (const record of ordinary.slice(count)) await fs.unlink(await this.file(user, record.fileName));
    }
    async mutate(user, id, change, expectedRevision) {
        return serialized(await this.directory(user), async () => {
            const record = await this.get(user, id);
            if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new ApiError(409, 'REVISION_CONFLICT', '백업 정보가 변경되었습니다.');
            if (change === 'delete') { await fs.unlink(await this.file(user, id)); return { deleted: true, fileName: id }; }
            const updated = { ...record, ...change, revision: record.revision + 1 };
            await atomicJson(await this.file(user, id), updated); return updated;
        });
    }
}
