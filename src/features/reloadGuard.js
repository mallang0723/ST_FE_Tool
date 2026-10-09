import { txt as koText } from '../i18n/ko.js';
import * as scriptModule from '@sillytavern/script';
import { getCurrentChatId } from '@sillytavern/script';
import { selected_group } from '@sillytavern/scripts/group-chats';
import { LOG_PREFIX, RELOAD_GREETING_GUARD_KEY } from './constants.js';
import { settings } from './state.js';

// Recover the visible snapshot only after an observed read failure for this exact
// chat. A shorter successful read may be another window's legitimate deletion.
// The early bridge blocks writes until the next successful read; never force-save.
function isChatLossMitigationSupported() {
    const mutex = scriptModule.reloadChatMutex;
    return !!mutex && typeof mutex.callback === 'function';
}

function installReloadGreetingGuard() {
    try {
        if (!isChatLossMitigationSupported()) {
            console.debug(`${LOG_PREFIX} ST 1.16.0 미만에서는 복구 보조를 사용할 수 없습니다`);
            return;
        }
        const mutex = scriptModule.reloadChatMutex;
        if (mutex.callback[RELOAD_GREETING_GUARD_KEY]) {
            return;
        }

        const original = mutex.callback;
        async function guardedReload(...args) {
            const snapshot = takeReloadSnapshot();
            try {
                return await original.apply(mutex, args);
            } finally {
                try {
                    await maybeRecoverFromGreetingOverwrite(snapshot);
                } catch (error) {
                    console.error(`${LOG_PREFIX} 채팅 복구 보조 실패: `, error);
                }
            }
        }
        guardedReload[RELOAD_GREETING_GUARD_KEY] = true;
        guardedReload.__baiBaiToolkitOriginal = original;
        mutex.callback = guardedReload;
        console.debug(`${LOG_PREFIX} 채팅 복구 보조 활성화`);
    } catch (error) {
        console.error(`${LOG_PREFIX} 채팅 복구 보조 활성화 실패: `, error);
    }
}

/**
 * 在 reload 清空内存之前,对当前聊天做快照。
 * @returns {null | {valid: boolean, inGroup: boolean, chatId: any, length: number, integrity: any, messages: any[], metadata: any}}
 */
function takeReloadSnapshot() {
    try {
        if (settings.chatLossMitigationEnabled === false) {
            return null;
        }
        const inGroup = !!selected_group;
        const inChar = scriptModule.this_chid !== undefined;
        if (!inGroup && !inChar) {
            // neutral / 临时聊天:reload 不会注入问候语并保存,跳过
            return null;
        }

        const c = scriptModule.chat;
        return {
            valid: true,
            inGroup,
            chatId: getCurrentChatId(),
            length: Array.isArray(c) ? c.length : 0,
            startedAt: Date.now(),
            target: inGroup ? { is_group: true, id: getCurrentChatId() } : {
                avatar_url: scriptModule.characters[scriptModule.this_chid]?.avatar,
                file_name: scriptModule.characters[scriptModule.this_chid]?.chat,
            },
            integrity: scriptModule.chat_metadata?.integrity,
            messages: Array.isArray(c) ? c.slice() : [],   // 仅浅拷贝引用,不序列化
            metadata: structuredClone(scriptModule.chat_metadata),
        };
    } catch (error) {
        console.error(`${LOG_PREFIX} 채팅 스냅샷 실패: `, error);
        return null;
    }
}

/**
 * 判定 reload 后是否发生了"读失败被问候语覆盖"。要求全部条件成立,对正常删除/切换零误判。
 * @param {ReturnType<typeof takeReloadSnapshot>} snap
 * @returns {boolean}
 */
function shouldRecoverChat(snap) {
    if (!snap || !snap.valid) {
        return false;
    }
    // 聊天身份必须未变(否则是用户主动导航/切聊天)
    if (snap.inGroup !== !!selected_group) {
        return false;
    }
    if (getCurrentChatId() !== snap.chatId) {
        return false;
    }
    if (!snap.inGroup && scriptModule.this_chid === undefined) {
        return false;
    }
    // 之前必须确有真实历史(>1 条),否则无可恢复
    if (snap.length <= 1) {
        return false;
    }

    const now = scriptModule.chat;
    if (!Array.isArray(now)) {
        return false;
    }

    const read = globalThis.__damsoEarlyBridge?.getReadState(snap.target);
    return read?.success === false && read.at >= snap.startedAt && now.length < snap.length;
}

/**
 * 检测并恢复被问候语覆盖的聊天记录。
 * @param {ReturnType<typeof takeReloadSnapshot>} snap
 */
async function maybeRecoverFromGreetingOverwrite(snap) {
    if (!shouldRecoverChat(snap)) {
        return;
    }

    console.warn(`${LOG_PREFIX} 채팅 덮어쓰기 감지 (이전 ${snap.length}개). 복구 시도 중…`);

    // 1) 原地恢复内存中的消息数组(chat 是只读绑定,不能赋值,只能 splice)
    const c = scriptModule.chat;
    c.splice(0, c.length, ...snap.messages);

    // 2) 原地把旧 metadata 写回当前(被 getChat 重赋的)对象,并恢复原 integrity
    const meta = scriptModule.chat_metadata;
    if (meta && snap.metadata) {
        for (const key of Object.keys(snap.metadata)) {
            meta[key] = snap.metadata[key];
        }
    }
    if (meta && snap.integrity) {
        meta.integrity = snap.integrity;
    }

    // 3) 先重新渲染恢复后的消息(即使后续写盘失败,用户也能立刻看到记录还在)
    await scriptModule.printMessages();

    scriptModule.cancelDebouncedChatSave();
    globalThis.toastr?.warning('채팅 읽기에 실패하여 화면의 이전 기록만 복원했습니다. 연결을 확인한 뒤 채팅을 다시 불러오세요.', '담소 도구함');
}

export {
    installReloadGreetingGuard,
    isChatLossMitigationSupported,
    maybeRecoverFromGreetingOverwrite,
    shouldRecoverChat,
    takeReloadSnapshot,
};
