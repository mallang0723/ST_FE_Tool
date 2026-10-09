import { CURRENT_VERSION } from './constants.js';
import { callGenericPopup, POPUP_TYPE } from '@sillytavern/scripts/popup';
export function initializeExtensionUpdateCheck() {}
export function initializeUpdateUI(container) {
    container.find('.bai_bai_toolkit_current_version').text(CURRENT_VERSION);
    container.find('.bai_bai_toolkit_update_status').text('개인용 통합판');
    container.find('.bai_bai_toolkit_update_badge').hide();
    container.find('.bai_bai_toolkit_update_button').hide();
}
export function queueExtensionUpdatePrompt() {
    return callGenericPopup('업데이트는 새 통합 ZIP의 설치 도구로 진행하세요. 화면·서버·초기 연결을 같은 버전으로 유지합니다.', POPUP_TYPE.TEXT, '', { okButton: '확인' });
}
