import { txt as koText } from '../i18n/ko.js';
import { api } from '../backend/client.js';
import { getRequestHeaders } from '@sillytavern/script';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '@sillytavern/scripts/popup';
import { PRESET_BACKUP_PREVIEW_APP_KEY, PRESET_BACKUP_PREVIEW_DELETE_URL, PRESET_BACKUP_PREVIEW_LIST_URL } from './constants.js';
import { LOG_PREFIX, extensionState, savePresetOptimizationSettings, settings } from './state.js';

export const PRESET_BACKUPS_CLEANED_EVENT = 'bai-bai-preset-backups-cleaned';
export const DEFAULT_PRESET_BACKUP_KEEP_COUNT = 200;

let mutationTail = Promise.resolve();
let cleanupPromise = null;
let cleanupRequested = false;
let changingSettings = false;

export function runPresetBackupMutation(operation) {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
}

async function requestBackupApi(url, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload || payload.ok === false || payload.error) throw new Error('Invalid backup response');
        return payload.data ?? payload;
    } finally {
        clearTimeout(timeout);
    }
}

export async function fetchPresetBackupItems() {
    const data = await requestBackupApi(PRESET_BACKUP_PREVIEW_LIST_URL, {});
    if (!Array.isArray(data.items)) throw new Error('Invalid backup list');
    return data.items;
}

export async function deletePresetBackupFile(fileName) {
    const data = await requestBackupApi(PRESET_BACKUP_PREVIEW_DELETE_URL, { fileName });
    if (data.deleted !== true || data.fileName !== fileName) {
        throw new Error('Backup deletion was not confirmed');
    }
    return data;
}

export function isValidPresetBackupKeepCount(value) {
    return Number.isSafeInteger(value) && value >= 1;
}

export function getPresetBackupCleanupPlan(items, keepCount) {
    if (!Array.isArray(items) || !isValidPresetBackupKeepCount(keepCount)) {
        throw new Error('Invalid backup retention settings or list');
    }
    const names = new Set();
    // Fail closed: never silently filter malformed rows out of a destructive plan.
    const entries = items.map(item => {
        const fileName = item?.fileName;
        const createdAt = item?.createdAt ?? item?.createdAtMs;
        const createdAtMs = typeof createdAt === 'number' ? createdAt
            : typeof createdAt === 'string' && createdAt.trim() ? Date.parse(createdAt) : NaN;
        if (
            typeof fileName !== 'string' || !fileName.trim() || fileName !== fileName.trim()
            || /[/\\\x00-\x1f]/.test(fileName) || !fileName.endsWith('.json') || fileName === 'index.json'
            || names.has(fileName) || !Number.isFinite(createdAtMs) || createdAtMs <= 0
            || typeof item.note !== 'string'
        ) {
            throw new Error(koText('ui.279'));
        }
        names.add(fileName);
        return { fileName, createdAtMs, protected: Boolean(item.note.trim()) };
    });
    const ordinary = entries.filter(item => !item.protected)
        .sort((a, b) => b.createdAtMs - a.createdAtMs || b.fileName.localeCompare(a.fileName));
    return {
        ordinaryCount: ordinary.length,
        protectedCount: entries.length - ordinary.length,
        targets: ordinary.slice(keepCount).reverse(),
    };
}

function canCleanBackups() {
    const view = extensionState[PRESET_BACKUP_PREVIEW_APP_KEY]?.state;
    return settings.presetBackupAutoCleanupEnabled === true
        && !changingSettings
        && !view?.noteDialogOpen && !view?.savingNote
        && !view?.renameDialogOpen && !view?.renaming
        && !view?.deleteDialogOpen && !view?.deleting
        && !view?.batchDeleting && !view?.importingFileName;
}

async function cleanPresetBackups() {
    if (!canCleanBackups()) return;
    const keepCount = settings.presetBackupKeepCount;
    const plan = getPresetBackupCleanupPlan(await fetchPresetBackupItems(), keepCount);
    if (!canCleanBackups() || settings.presetBackupKeepCount !== keepCount) return;
    const deletedFileNames = [];
    try {
        for (const item of plan.targets) {
            if (!canCleanBackups() || settings.presetBackupKeepCount !== keepCount) break;
            await deletePresetBackupFile(item.fileName);
            deletedFileNames.push(item.fileName);
        }
    } finally {
        if (deletedFileNames.length) {
            document.dispatchEvent(new CustomEvent(PRESET_BACKUPS_CLEANED_EVENT, {
                detail: { deletedFileNames },
            }));
        }
    }
}

export function schedulePresetBackupCleanup() {
    if (!canCleanBackups()) return Promise.resolve();
    cleanupRequested = true;
    if (cleanupPromise) return cleanupPromise;
    // ponytail: one page-local queue; cross-device atomic retention needs backend support.
    cleanupPromise = Promise.resolve().then(async () => {
        while (cleanupRequested && canCleanBackups()) {
            cleanupRequested = false;
            await runPresetBackupMutation(cleanPresetBackups);
        }
    }).catch(error => {
        cleanupRequested = false;
        console.warn(`${LOG_PREFIX} Preset backup cleanup stopped`, error);
        globalThis.toastr?.warning(
            koText('ui.280'),
            koText('ui.281'),
        );
    }).finally(() => {
        cleanupPromise = null;
    });
    return cleanupPromise;
}

async function confirmPresetBackupCleanup(plan, keepCount) {
    const result = await callGenericPopup(`
        <h3>오래된 백업 자동 정리</h3>
        <p>전체 프리셋의 최신 일반 백업 ${keepCount}개를 보관합니다.</p>
        <p>현재 일반 백업 ${plan.ordinaryCount}개, 메모가 있는 보호 백업 ${plan.protectedCount}개.</p>
        <p>오래된 일반 백업 <strong>${plan.targets.length}</strong>개를 삭제합니다. 되돌릴 수 없습니다.</p>
        <p>메모가 있는 백업은 삭제하거나 개수에 포함하지 않습니다. 이후에는 백업 성공 후 초과분을 정리합니다.</p>
`, POPUP_TYPE.CONFIRM, '', {
        okButton: koText('ui.287'),
        cancelButton: koText('ui.163'),
    });
    return result === POPUP_RESULT.AFFIRMATIVE;
}

export async function changePresetBackupRetentionSettings(enabled, keepCount) {
    if (changingSettings) return false;
    if (!isValidPresetBackupKeepCount(keepCount)) {
        throw new Error(koText('ui.288'));
    }
    const needsConfirmation = enabled && (
        settings.presetBackupAutoCleanupEnabled !== true
        || !isValidPresetBackupKeepCount(settings.presetBackupKeepCount)
        || keepCount < settings.presetBackupKeepCount
    );
    changingSettings = true;
    try {
        await cleanupPromise;
        if (needsConfirmation) {
            const plan = await runPresetBackupMutation(async () =>
                getPresetBackupCleanupPlan(await fetchPresetBackupItems(), keepCount));
            if (!await confirmPresetBackupCleanup(plan, keepCount)) return false;
        }
        const current = await api('/config');
        const saved = await api('/config', { method: 'PUT', body: JSON.stringify({ expectedRevision: current.revision, backupAutoCleanupEnabled: enabled, backupKeepCount: keepCount }) });
        if (needsConfirmation) await api('/preset-backups/prune', { method: 'POST', body: JSON.stringify({ expectedRevision: saved.revision }) });
        settings.presetBackupAutoCleanupEnabled = enabled;
        settings.presetBackupKeepCount = keepCount;
        savePresetOptimizationSettings();
    } finally {
        changingSettings = false;
    }
    return true;
}

export function bindPresetBackupRetentionSettings(container) {
    const root = container[0] ?? container;
    const toggle = root.querySelector('#bai_bai_toolkit_preset_backup_auto_cleanup_enabled');
    const count = root.querySelector('#bai_bai_toolkit_preset_backup_keep_count');
    const status = root.querySelector('#bai_bai_toolkit_preset_backup_cleanup_status');
    if (!toggle || !count || !status) return;
    const sync = () => {
        toggle.checked = settings.presetBackupAutoCleanupEnabled === true;
        count.value = isValidPresetBackupKeepCount(settings.presetBackupKeepCount)
            ? settings.presetBackupKeepCount : DEFAULT_PRESET_BACKUP_KEEP_COUNT;
    };
    const update = async () => {
        const enabled = toggle.checked;
        const keepCount = count.valueAsNumber;
        toggle.disabled = count.disabled = true;
        status.hidden = false;
        status.textContent = koText('ui.289');
        try {
            await changePresetBackupRetentionSettings(enabled, keepCount);
            status.hidden = true;
        } catch (error) {
            console.warn(`${LOG_PREFIX} Failed to change backup retention settings`, error);
            status.textContent = `설정을 변경하지 못했습니다: ${error.message}`;
        } finally {
            sync();
            toggle.disabled = count.disabled = false;
        }
    };
    sync();
    toggle.addEventListener('change', update);
    count.addEventListener('change', update);
}
