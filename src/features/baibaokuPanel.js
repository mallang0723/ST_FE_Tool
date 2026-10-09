import { api } from '../backend/client.js';
import { installJobsPanel } from '../backend/jobs-panel.js';
import { callGenericPopup, POPUP_TYPE } from '@sillytavern/scripts/popup';
import { settings } from './state.js';
import { setPresetAutoBackupBackendAvailable } from '../preset/autoBackup.js';
import { CURRENT_VERSION } from './constants.js';
let config;
const optionMap = {
    baibaokuSettingsAccelerationEnabled: 'settingsAccelerationEnabled', baibaokuLazyThemeLoadingEnabled: 'lazyThemeLoadingEnabled',
    fastCharacterListEnabled: 'characterListAccelerationEnabled', recentChatListAccelerationEnabled: 'recentChatListAccelerationEnabled',
    extensionManifestBundleEnabled: 'extensionManifestBundleEnabled', tokenizerBulkCountEnabled: 'tokenizerBulkCountEnabled',
    chatKeyboardScanReductionEnabled: 'chatKeyboardScanReductionEnabled',
};
export async function fetchBaibaokuStatus() { return api('/status'); }
export async function fetchBaibaokuFastConfig() { return config = await api('/config'); }
export async function saveBaibaokuFastConfig(changes) {
    if (!config) await fetchBaibaokuFastConfig();
    config = await api('/config', { method: 'PUT', body: JSON.stringify({ ...changes, expectedRevision: config.revision }) });
    for (const [local, server] of Object.entries(optionMap)) settings[local] = config[server];
    const bridge = globalThis.__damsoEarlyBridge;
    if (bridge) { bridge.config = { ...config }; Object.assign(bridge, config); }
    return config;
}
export function applyBaibaokuPanelLocalState(container) {
    container.find('#bai_bai_toolkit_progressive_chat_loading_enabled').prop('disabled',true).prop('checked',false);
    const bridge = globalThis.__damsoEarlyBridge;
    container.find('#bai_bai_toolkit_baibaoku_bridge_status').text(bridge?.installed ? '연결됨 · ' + bridge.version : '미연결');
}
export async function refreshBaibaokuPanelStatus(container) {
    applyBaibaokuPanelLocalState(container);
    try {
        const [server, saved] = await Promise.all([fetchBaibaokuStatus(), fetchBaibaokuFastConfig()]);
        const compatible = server.protocolVersion === 1 && server.packageVersion === CURRENT_VERSION && server.host.supported;
        container.find('#bai_bai_toolkit_baibaoku_server_status').text(compatible ? '연결됨 · ' + server.packageVersion : '버전 또는 호스트 연결 확인 필요');
        container.find('#bai_bai_toolkit_baibaoku_driver_status').text(server.storage.ready ? '사용자별 파일 저장소 정상' : '사용 불가');
        setPresetAutoBackupBackendAvailable(compatible && server.capabilities.presetBackups);
        container.find('#bai_bai_toolkit_save_generate_enabled').prop('disabled', !compatible || !server.capabilities.backgroundJobs);
        for (const [local, remote] of Object.entries(optionMap)) settings[local] = saved[remote];
        settings.presetBackupAutoCleanupEnabled = saved.backupAutoCleanupEnabled;
        settings.presetBackupKeepCount = saved.backupKeepCount;
        container.find('#bai_bai_toolkit_preset_backup_auto_cleanup_enabled').prop('checked', saved.backupAutoCleanupEnabled);
        container.find('#bai_bai_toolkit_preset_backup_keep_count').val(saved.backupKeepCount);
        const bridge = globalThis.__damsoEarlyBridge;
        if (bridge) { bridge.config = { ...saved }; Object.assign(bridge, saved); }
        const ids = { baibaokuSettingsAccelerationEnabled:'baibaoku_settings_acceleration', baibaokuLazyThemeLoadingEnabled:'baibaoku_lazy_theme_loading', fastCharacterListEnabled:'fast_character_list', recentChatListAccelerationEnabled:'recent_chat_list_acceleration', extensionManifestBundleEnabled:'extension_manifest_bundle', tokenizerBulkCountEnabled:'tokenizer_bulk_count', chatKeyboardScanReductionEnabled:'chat_keyboard_scan_reduction' };
        for (const [key,id] of Object.entries(ids)) container.find('#bai_bai_toolkit_' + id + '_enabled').prop('checked',settings[key] === true);
    } catch {
        setPresetAutoBackupBackendAvailable(false);
        container.find('#bai_bai_toolkit_baibaoku_server_status').text('미연결 · 통합 설치와 서버 재시작을 확인하세요');
        container.find('#bai_bai_toolkit_baibaoku_driver_status').text('확인하지 못함');
    }
}
export function showBaibaokuInstallHelpPrompt() {
    return callGenericPopup('<h3>담소 도구함 통합 설치</h3><p>설치 ZIP의 install.mjs로 화면 확장·서버·호스트 연결을 함께 설치하고 SillyTavern을 재시작하세요.</p><p>1.18.0·1.19.0을 지원합니다. 원본 BaiBai 확장과 동시에 켜지 마세요.</p>', POPUP_TYPE.TEXT, '', { okButton:'확인' });
}
export function initializeBaibaokuPanel(container) {
    installJobsPanel(container);
    container.find('#bai_bai_toolkit_baibaoku_refresh_status').off('click.damso').on('click.damso',() => refreshBaibaokuPanelStatus(container));
    container.find('#bai_bai_toolkit_baibaoku_install_help').off('click.damso').on('click.damso',showBaibaokuInstallHelpPrompt);
    void refreshBaibaokuPanelStatus(container);
}
