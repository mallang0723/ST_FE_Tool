export const PACKAGE_VERSION = '0.1.0';
export const PROTOCOL_VERSION = 1;
export const API_ROOT = '/api/plugins/st-ko-tools/v1';
export const HOST_VERSIONS = ['1.18.0', '1.19.0'];
export const TERMINAL = new Set(['saved', 'conflict', 'canceled', 'failed', 'interrupted']);
export const CONFIG_DEFAULTS = Object.freeze({
    settingsAccelerationEnabled: true, lazyThemeLoadingEnabled: true,
    extensionManifestBundleEnabled: true, characterListAccelerationEnabled: true,
    recentChatListAccelerationEnabled: true, tokenizerBulkCountEnabled: true,
    chatKeyboardScanReductionEnabled: false, progressiveChatLoadingEnabled: false,
    backupAutoCleanupEnabled: true, backupKeepCount: 200,
});
export class ApiError extends Error {
    constructor(status, code, message, details = {}) {
        super(message); Object.assign(this, { status, code, details });
    }
}
export function requireValue(condition, message = '요청 형식이 올바르지 않습니다.') {
    if (!condition) throw new ApiError(400, 'INVALID_REQUEST', message);
}
