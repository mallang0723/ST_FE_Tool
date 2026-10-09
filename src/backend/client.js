import { getRequestHeaders } from '@sillytavern/script';
export const API = '/api/plugins/st-ko-tools/v1';
export async function api(route, options = {}) {
    const response = await fetch(API + route, { ...options, headers: { ...getRequestHeaders(), ...options.headers } });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error?.message || '내장 서버 요청에 실패했습니다.');
        error.status = response.status; error.code = payload.error?.code; throw error;
    }
    return payload.data ?? payload;
}
let libraryRevision;
// Local adapter for the existing library UI; no external database or injected bridge.
export const libraryStore = {
    async get() { const doc = await api('/prompt-library'); libraryRevision = doc.revision; return { exists: true, value: doc }; },
    async set(_store, _key, value) {
        if (libraryRevision === undefined) await this.get();
        const doc = await api('/prompt-library', { method: 'PUT', body: JSON.stringify({ ...value, expectedRevision: libraryRevision }) });
        libraryRevision = doc.revision; return doc;
    },
};
