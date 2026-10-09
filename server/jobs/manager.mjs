import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, TERMINAL, requireValue } from '../../shared/contracts/index.mjs';
import { atomicJson, readJson, serialized, userStore } from '../storage/documents.mjs';

export class JobManager {
    constructor(host) { this.host = host; this.active = new Map(); this.users = new Map(); this.stopping = false; }
    async state(user) {
        const root = await userStore(user);
        if (!this.users.has(root)) this.users.set(root, this.restore(user, root));
        return this.users.get(root);
    }
    async restore(user, root) {
        const file = path.join(root, 'jobs.json');
        const doc = await readJson(file, { schemaVersion: 1, revision: 0, jobs: [] });
        if (doc.schemaVersion !== 1 || !Array.isArray(doc.jobs)) throw new ApiError(503, 'INVALID_JOBS', '작업 기록을 확인해 주세요.');
        const state = { file, doc, user };
        for (const job of doc.jobs.filter(j => !TERMINAL.has(j.status))) {
            await this.host.coordinator.withChatWrite(user, async () => {
                const target = this.host.coordinator.chatPath(user, job.target);
                const chat = await this.readChat(target);
                const saved = chat.some(m => m.extra?.damsoJobId === job.id);
                job.status = saved ? 'saved' : 'interrupted';
                if (saved) job.savedRevision = this.host.coordinator.fileRevision(target);
            });
        }
        await this.persist(state); return state;
    }
    async persist(state) { state.doc.revision++; await atomicJson(state.file, state.doc); }
    async readChat(file) {
        try { return (await fs.readFile(file, 'utf8')).split('\n').filter(x => x.trim()).map(x => JSON.parse(x)); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }
    async list(user) { return (await this.state(user)).doc.jobs.map(j => structuredClone(j)); }
    async get(user, id) {
        const job = (await this.state(user)).doc.jobs.find(j => j.id === id || j.clientRequestId === id);
        if (!job) throw new ApiError(404, 'NOT_FOUND', '작업을 찾을 수 없습니다.'); return structuredClone(job);
    }
    async submit(user, body) {
        requireValue(!this.stopping, '서버를 종료하고 있습니다.');
        requireValue(typeof body.clientRequestId === 'string' && body.clientRequestId.length <= 160 && body.clientRequestId.length >= 8);
        const state = await this.state(user);
        return this.host.coordinator.withChatWrite(user, () => serialized(state.file, async () => {
            const existing = state.doc.jobs.find(j => j.clientRequestId === body.clientRequestId);
            if (existing) return structuredClone(existing);
            const generate = structuredClone(body.generate);
            requireValue(generate && ['openai','custom'].includes(generate.chat_completion_source), '백그라운드 생성은 OpenAI·Custom 소스를 지원합니다.');
            requireValue(Number(generate.n ?? 1) === 1 && ['normal','regenerate'].includes(body.target?.type));
            requireValue(Array.isArray(generate.messages) && typeof body.expectedRevision === 'string');
            if (generate.tools?.length) {
                const tool = generate.tools[0];
                requireValue(generate.tools.length === 1 && tool.type === 'function' && /^emit_complete_response(?:_[a-zA-Z0-9]+)?$/.test(tool?.function?.name) && tool.function.parameters?.type === 'object' && tool.function.parameters?.properties?.content?.type === 'string' && tool.function.parameters.required?.includes('content'), '일반 도구 호출은 기본 생성으로 실행해 주세요.');
            }
            // Keys remain in the native host secret store; explicit proxy/custom passwords stay in memory only.
            delete generate.__baibai_generation_id;
            const target = { avatar_url: body.target.avatar_url, file_name: body.target.file_name, type: body.target.type, ch_name: String(body.target.ch_name || ''), chatId: String(body.target.chatId || '') };
            {
                const file = this.host.coordinator.chatPath(user, target);
                if (this.host.coordinator.fileRevision(file) !== body.expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', '채팅이 변경되어 생성을 시작하지 않았습니다.');
                const chat = await this.readChat(file);
                requireValue(chat.length >= 2, '먼저 채팅을 저장해 주세요.');
            }
            const job = { id: randomUUID(), clientRequestId: body.clientRequestId, runId: body.runId || body.clientRequestId, attempt: body.attempt || 0,
                target, expectedRevision: body.expectedRevision, status: 'accepted', createdAt: Date.now(), toolName: generate.tools?.[0]?.function?.name || '' };
            state.doc.jobs.push(job); await this.persist(state);
            const controller = new AbortController();
            const active = { controller, promise: null };
            this.active.set(job.id, active);
            active.promise = this.run(state, job, generate, controller.signal).finally(() => this.active.delete(job.id));
            return structuredClone(job);
        }));
    }
    async update(state, job, changes) {
        return serialized(state.file, async () => { Object.assign(job, changes, { updatedAt: Date.now() }); await this.persist(state); });
    }
    async run(state, job, generate, signal) {
        try {
            await this.update(state, job, { status: 'running' });
            if (signal.aborted) throw new ApiError(499, 'CANCELED', '중단됨');
            const response = await this.host.generate(state.user, generate, signal);
            if (signal.aborted) throw new ApiError(499, 'CANCELED', '중단됨');
            const choice = response?.choices?.[0];
            const message = choice?.message;
            let content = message?.content ?? choice?.text;
            if (job.toolName && message?.tool_calls?.length === 1 && message.tool_calls[0].function?.name === job.toolName) {
                content = JSON.parse(message.tool_calls[0].function.arguments).content;
            }
            requireValue(typeof content === 'string' && content.length > 0, '모델에서 저장할 답변을 받지 못했습니다.');
            const result = { content, reasoning: message?.reasoning_content ?? message?.reasoning ?? '', response };
            await this.update(state, job, { status: 'completed', result });
            await this.host.coordinator.withChatWrite(state.user, () => serialized(state.file, async () => {
                if (signal.aborted || job.status === 'canceled' || job.status === 'interrupted') return;
                const file = this.host.coordinator.chatPath(state.user, job.target);
                const chat = await this.readChat(file);
                if (chat.some(m => m.extra?.damsoJobId === job.id)) { job.status = 'saved'; job.savedRevision = this.host.coordinator.fileRevision(file); await this.persist(state); return; }
                if (this.host.coordinator.fileRevision(file) !== job.expectedRevision) { job.status = 'conflict'; await this.persist(state); return; }
                job.status = 'committing'; await this.persist(state);
                const reply = { name: job.target.ch_name, is_user: false, is_system: false, send_date: new Date().toISOString(), mes: content,
                    extra: { damsoJobId: job.id, reasoning: result.reasoning, api: 'openai', model: generate.model }, swipe_id: 0, swipes: [content] };
                if (job.target.type === 'regenerate' && chat.at(-1)?.is_user === false && !chat.at(-1)?.is_system) chat[chat.length - 1] = { ...chat.at(-1), ...reply };
                else chat.push(reply);
                await this.host.save(state.user, file, chat, job.target.avatar_url);
                job.status = 'saved'; job.savedRevision = this.host.coordinator.fileRevision(file); await this.persist(state);
            }));
        } catch (error) {
            if (TERMINAL.has(job.status)) return;
            await this.update(state, job, { status: signal.aborted ? (this.stopping ? 'interrupted' : 'canceled') : 'failed', error: { code: error.code || 'GENERATION_FAILED', message: '생성 또는 저장을 완료하지 못했습니다.', retryable: ![400,401,403,404,413,422,499].includes(error.status) } });
        }
    }
    async cancel(user, id) {
        const state = await this.state(user);
        return serialized(state.file, async () => {
            const job = state.doc.jobs.find(j => j.id === id);
            if (!job) throw new ApiError(404, 'NOT_FOUND', '작업을 찾을 수 없습니다.');
            if (TERMINAL.has(job.status)) return structuredClone(job);
            job.status = 'canceled'; this.active.get(id)?.controller.abort(); await this.persist(state);
            return structuredClone(job);
        });
    }
    async stop() {
        this.stopping = true;
        for (const { controller } of this.active.values()) controller.abort();
        await Promise.allSettled([...this.active.values()].map(a => a.promise));
    }
}
