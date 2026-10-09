import { readDocument, changeDocument } from '../storage/documents.mjs';
import { requireValue } from '../../shared/contracts/index.mjs';
const defaults = { items: [], groups: [] };
export const getLibrary = user => readDocument(user, 'prompt-library', defaults);
export function putLibrary(user, body) {
    requireValue(Array.isArray(body.items) && Array.isArray(body.groups));
    for (const entries of [body.items, body.groups]) {
        requireValue(entries.length <= 10000);
        const ids = entries.map(x => x?.id);
        requireValue(ids.every(x => typeof x === 'string' && x) && new Set(ids).size === ids.length, '항목 ID는 비어 있거나 중복될 수 없습니다.');
    }
    return changeDocument(user, 'prompt-library', defaults, body.expectedRevision, current => ({ ...current, items: body.items, groups: body.groups }));
}
