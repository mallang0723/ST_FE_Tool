import { txt as koText } from '../i18n/ko.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '@sillytavern/scripts/popup';
import { resetScrollHeight } from '@sillytavern/scripts/utils';
import { loadWorldInfo, saveWorldInfo, setWIOriginalDataValue, world_names } from '@sillytavern/scripts/world-info';
import { WORLD_INFO_SEARCH_REPLACE_PANEL_CLASS } from './constants.js';
import { LOG_PREFIX, settings } from './state.js';
import { getWorldInfoVueListOptimizationState } from './vueList.js';

function installWorldInfoSearchReplacePanel(state = getWorldInfoVueListOptimizationState()) {
    if (!settings.worldInfoListOptimizationEnabled || settings.worldInfoSearchReplaceEnabled === false) {
        removeWorldInfoSearchReplacePanel(state);
        return;
    }

    const list = document.getElementById('world_popup_entries_list');

    if (!(list instanceof HTMLElement)) {
        return;
    }

    if (state.worldInfoSearchReplacePanel instanceof HTMLElement
        && state.worldInfoSearchReplacePanel.isConnected
        && state.worldInfoSearchReplacePanel.nextElementSibling === list) {
        return;
    }

    removeWorldInfoSearchReplacePanel(state);

    const panel = document.createElement('div');
    panel.className = `${WORLD_INFO_SEARCH_REPLACE_PANEL_CLASS} inline-drawer`;
    const collapsed = true;
    panel.dataset.collapsed = collapsed ? 'true' : 'false';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header standoutHeader bai-bai-wi-search-replace-header';
    header.tabIndex = 0;
    header.role = 'button';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

    const title = document.createElement('span');
    title.className = 'bai-bai-wi-search-replace-title';
    title.textContent = koText('ui.435');

    const summary = document.createElement('span');
    summary.className = 'bai-bai-wi-search-replace-summary';
    summary.textContent = '';

    const toggleIcon = document.createElement('div');
    toggleIcon.className = `inline-drawer-icon fa-solid ${collapsed ? 'fa-circle-chevron-down down' : 'fa-circle-chevron-up up'}`;
    toggleIcon.setAttribute('aria-hidden', 'true');

    header.append(title, summary, toggleIcon);

    const body = document.createElement('div');
    body.className = 'inline-drawer-content bai-bai-wi-search-replace-body';
    body.style.display = collapsed ? 'none' : 'block';

    const form = document.createElement('div');
    form.className = 'bai-bai-wi-search-replace-form';

    const findInput = document.createElement('input');
    findInput.type = 'text';
    findInput.className = 'text_pole bai-bai-wi-search-replace-find';
    findInput.placeholder = koText('ui.436');
    findInput.autocomplete = 'off';

    const replaceInput = document.createElement('input');
    replaceInput.type = 'text';
    replaceInput.className = 'text_pole bai-bai-wi-search-replace-replace';
    replaceInput.placeholder = koText('ui.437');
    replaceInput.autocomplete = 'off';

    const caseLabel = document.createElement('label');
    caseLabel.className = 'checkbox_label bai-bai-wi-search-replace-case';
    const caseInput = document.createElement('input');
    caseInput.type = 'checkbox';
    const caseText = document.createElement('span');
    caseText.textContent = koText('ui.438');
    caseLabel.append(caseInput, caseText);

    const commentLabel = document.createElement('label');
    commentLabel.className = 'checkbox_label bai-bai-wi-search-replace-comment';
    const commentInput = document.createElement('input');
    commentInput.type = 'checkbox';
    const commentText = document.createElement('span');
    commentText.textContent = koText('ui.439');
    commentLabel.append(commentInput, commentText);

    const countButton = document.createElement('button');
    countButton.type = 'button';
    countButton.className = 'menu_button bai-bai-wi-search-replace-count';
    countButton.textContent = koText('ui.440');

    const replaceButton = document.createElement('button');
    replaceButton.type = 'button';
    replaceButton.className = 'menu_button danger_button bai-bai-wi-search-replace-apply';
    replaceButton.textContent = koText('ui.441');

    form.append(findInput, replaceInput, caseLabel, commentLabel, countButton, replaceButton);
    body.append(form);
    panel.append(header, body);
    list.before(panel);

    const controls = { panel, header, summary, toggleIcon, findInput, replaceInput, caseInput, commentInput, countButton, replaceButton };
    const handlers = [];
    const addHandler = (target, eventName, handler) => {
        target.addEventListener(eventName, handler);
        handlers.push({ target, eventName, handler });
    };

    const refreshControls = () => refreshWorldInfoSearchReplacePanelControls(state, controls);

    addHandler(panel, 'inline-drawer-toggle', () => {
        const nextCollapsed = toggleIcon.classList.contains('down');
        panel.dataset.collapsed = nextCollapsed ? 'true' : 'false';
        header.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
    });

    addHandler(findInput, 'input', () => {
        state.worldInfoSearchReplaceStats = null;
        refreshControls();
    });
    addHandler(replaceInput, 'input', () => {
        state.worldInfoSearchReplaceStats = null;
        refreshControls();
    });
    addHandler(caseInput, 'change', () => {
        state.worldInfoSearchReplaceStats = null;
        refreshControls();
    });
    addHandler(commentInput, 'change', () => {
        state.worldInfoSearchReplaceStats = null;
        refreshControls();
    });
    addHandler(countButton, 'click', () => handleWorldInfoSearchReplaceCount(state, controls));
    addHandler(replaceButton, 'click', () => handleWorldInfoSearchReplaceApply(state, controls));

    state.worldInfoSearchReplacePanel = panel;
    state.worldInfoSearchReplaceHandlers = handlers;
    refreshControls();
}

function removeWorldInfoSearchReplacePanel(state = getWorldInfoVueListOptimizationState()) {
    for (const entry of state.worldInfoSearchReplaceHandlers || []) {
        entry.target?.removeEventListener?.(entry.eventName, entry.handler);
    }

    state.worldInfoSearchReplaceHandlers = [];
    state.worldInfoSearchReplacePanel?.remove?.();
    state.worldInfoSearchReplacePanel = null;
    state.worldInfoSearchReplaceStats = null;
}

function refreshWorldInfoSearchReplacePanelControls(state, controls) {
    const findValue = controls.findInput.value;
    const hasQuery = findValue.length > 0;
    const worldName = getCurrentWorldInfoEditorName();

    controls.countButton.disabled = !hasQuery;
    controls.replaceButton.disabled = !hasQuery;

    const stats = state.worldInfoSearchReplaceStats;
    if (hasQuery
        && worldName
        && stats
        && stats.worldName === worldName
        && stats.findValue === findValue
        && stats.caseSensitive === controls.caseInput.checked
        && stats.includeComment === controls.commentInput.checked) {
        controls.summary.textContent = `일치: ${stats.matchedEntries}개 항목 / ${stats.replacementCount}곳`;
        return;
    }

    controls.summary.textContent = '';
}

async function handleWorldInfoSearchReplaceCount(state, controls) {
    const query = getWorldInfoSearchReplaceQuery(controls);

    if (!query) {
        refreshWorldInfoSearchReplacePanelControls(state, controls);
        showWorldInfoSearchReplaceToast('warning', koText('ui.445'));
        return;
    }

    setWorldInfoSearchReplaceBusy(controls, true);

    try {
        const stats = await getWorldInfoSearchReplaceStats(query);
        state.worldInfoSearchReplaceStats = stats;
        refreshWorldInfoSearchReplacePanelControls(state, controls);

        if (stats.replacementCount === 0) {
            showWorldInfoSearchReplaceToast('warning', koText('ui.446'));
        }
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to count World Info search matches`, error);
        showWorldInfoSearchReplaceToast('error', `일치 개수 확인 실패: ${error?.message || String(error)}`);
    } finally {
        setWorldInfoSearchReplaceBusy(controls, false);
    }
}

async function handleWorldInfoSearchReplaceApply(state, controls) {
    const query = getWorldInfoSearchReplaceQuery(controls);

    if (!query) {
        refreshWorldInfoSearchReplacePanelControls(state, controls);
        showWorldInfoSearchReplaceToast('warning', koText('ui.445'));
        return;
    }

    setWorldInfoSearchReplaceBusy(controls, true);

    try {
        const stats = await getWorldInfoSearchReplaceStats(query);
        state.worldInfoSearchReplaceStats = stats;
        refreshWorldInfoSearchReplacePanelControls(state, controls);

        if (stats.replacementCount === 0) {
            showWorldInfoSearchReplaceToast('warning', koText('ui.446'));
            return;
        }

        const confirmed = await confirmWorldInfoSearchReplace(stats);
        if (!confirmed) {
            return;
        }

        const appliedStats = await applyWorldInfoSearchReplace(query);
        state.worldInfoSearchReplaceStats = await getWorldInfoSearchReplaceStats(query);
        refreshWorldInfoSearchReplacePanelControls(state, controls);
        syncRenderedWorldInfoSearchReplaceContent(appliedStats.updatedEntries);
        showWorldInfoSearchReplaceToast('success', `치환 완료: ${appliedStats.matchedEntries}개 항목 / ${appliedStats.replacementCount}곳.`);
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to replace World Info content`, error);
        showWorldInfoSearchReplaceToast('error', `치환 실패: ${error?.message || String(error)}`);
    } finally {
        setWorldInfoSearchReplaceBusy(controls, false);
    }
}

function getWorldInfoSearchReplaceQuery(controls) {
    const worldName = getCurrentWorldInfoEditorName();
    const findValue = controls.findInput.value;

    if (!worldName || findValue.length === 0) {
        return null;
    }

    return {
        worldName,
        findValue,
        replaceValue: controls.replaceInput.value,
        caseSensitive: controls.caseInput.checked,
        includeComment: controls.commentInput.checked,
    };
}

async function getWorldInfoSearchReplaceStats(query) {
    const data = await loadWorldInfo(query.worldName);

    if (!data?.entries || typeof data.entries !== 'object') {
        throw new Error(koText('ui.451'));
    }

    return countWorldInfoSearchReplaceMatches(data, query);
}

async function applyWorldInfoSearchReplace(query) {
    const data = await loadWorldInfo(query.worldName);

    if (!data?.entries || typeof data.entries !== 'object') {
        throw new Error(koText('ui.451'));
    }

    const regex = createWorldInfoSearchReplaceRegex(query.findValue, query.caseSensitive);
    let matchedEntries = 0;
    let replacementCount = 0;
    const updatedEntries = [];

    for (const entry of Object.values(data.entries)) {
        if (!entry) {
            continue;
        }

        let entryCount = 0;
        const updatedEntry = { uid: entry.uid };

        if (typeof entry.content === 'string') {
            const { value, count } = replaceWorldInfoSearchReplaceValue(entry.content, regex, query.replaceValue);

            if (count > 0) {
                entryCount += count;
                entry.content = value;
                setWIOriginalDataValue(data, entry.uid, 'content', value);
                updatedEntry.content = value;
            }
        }

        if (query.includeComment && typeof entry.comment === 'string') {
            const { value, count } = replaceWorldInfoSearchReplaceValue(entry.comment, regex, query.replaceValue);

            if (count > 0) {
                entryCount += count;
                entry.comment = value;
                setWIOriginalDataValue(data, entry.uid, 'comment', value);
                updatedEntry.comment = value;
            }
        }

        if (entryCount > 0) {
            matchedEntries += 1;
            replacementCount += entryCount;
            updatedEntries.push(updatedEntry);
        }
    }

    if (replacementCount > 0) {
        await saveWorldInfo(query.worldName, data, true);
    }

    return { matchedEntries, replacementCount, updatedEntries };
}

function replaceWorldInfoSearchReplaceValue(source, regex, replaceValue) {
    let count = 0;
    regex.lastIndex = 0;
    const value = source.replace(regex, () => {
        count += 1;
        return replaceValue;
    });

    return { value, count };
}

function syncRenderedWorldInfoSearchReplaceContent(updatedEntries) {
    if (!Array.isArray(updatedEntries) || updatedEntries.length === 0) {
        return;
    }

    for (const { uid, content, comment } of updatedEntries) {
        const entry = document.querySelector(`#world_popup_entries_list .world_entry[uid="${escapeWorldInfoSearchReplaceCssValue(uid)}"]`);
        const contentTextarea = entry?.querySelector?.('textarea[name="content"]');
        const commentTextarea = entry?.querySelector?.('textarea[name="comment"]');

        if (typeof content === 'string' && contentTextarea instanceof HTMLTextAreaElement) {
            contentTextarea.value = content;

            if (!globalThis.CSS?.supports?.('field-sizing', 'content')) {
                void resetScrollHeight(contentTextarea);
            }
        }

        if (typeof comment === 'string' && commentTextarea instanceof HTMLTextAreaElement) {
            commentTextarea.value = comment;

            if (!globalThis.CSS?.supports?.('field-sizing', 'content')) {
                void resetScrollHeight(commentTextarea);
            }
        }
    }
}

function escapeWorldInfoSearchReplaceCssValue(value) {
    if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(String(value));
    }

    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function countWorldInfoSearchReplaceMatches(data, query) {
    const regex = createWorldInfoSearchReplaceRegex(query.findValue, query.caseSensitive);
    let matchedEntries = 0;
    let replacementCount = 0;

    for (const entry of Object.values(data.entries)) {
        if (!entry) {
            continue;
        }

        const contentCount = typeof entry.content === 'string'
            ? countWorldInfoSearchReplaceValue(entry.content, regex)
            : 0;
        const commentCount = query.includeComment && typeof entry.comment === 'string'
            ? countWorldInfoSearchReplaceValue(entry.comment, regex)
            : 0;
        const entryCount = contentCount + commentCount;

        if (entryCount === 0) {
            continue;
        }

        matchedEntries += 1;
        replacementCount += entryCount;
    }

    return {
        worldName: query.worldName,
        findValue: query.findValue,
        caseSensitive: query.caseSensitive,
        includeComment: query.includeComment,
        matchedEntries,
        replacementCount,
    };
}

function countWorldInfoSearchReplaceValue(source, regex) {
    regex.lastIndex = 0;
    return source.match(regex)?.length ?? 0;
}

function createWorldInfoSearchReplaceRegex(value, caseSensitive) {
    return new RegExp(escapeWorldInfoSearchReplaceRegExp(value), caseSensitive ? 'g' : 'gi');
}

function escapeWorldInfoSearchReplaceRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function confirmWorldInfoSearchReplace(stats) {
    const scopeText = stats.includeComment ? koText('ui.452') : koText('ui.453');
    const result = await callGenericPopup(`
        <div class="bai-bai-wi-search-replace-confirm">
            <p>세계관 설정집 <strong>${escapeWorldInfoSearchReplaceHtml(stats.worldName)}</strong>의 변경 대상: ${scopeText}.</p>
            <p>일치 항목: <strong>${stats.matchedEntries}</strong>개<br>치환 횟수: <strong>${stats.replacementCount}</strong>곳</p>
            <p>즉시 저장되는 변경입니다. 확인 후 계속하세요.</p>
        </div>
`, POPUP_TYPE.CONFIRM, '', {
        okButton: koText('ui.441'),
        cancelButton: koText('ui.163'),
    });

    return result === POPUP_RESULT.AFFIRMATIVE || result === true;
}

function escapeWorldInfoSearchReplaceHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[character]));
}

function getCurrentWorldInfoEditorName() {
    const select = document.getElementById('world_editor_select');

    if (!(select instanceof HTMLSelectElement) || select.value === '') {
        return null;
    }

    const selectedValue = select.value.trim();
    const selectedIndex = Number.parseInt(selectedValue, 10);
    if (/^\d+$/.test(selectedValue) && Number.isInteger(selectedIndex) && world_names?.[selectedIndex]) {
        return world_names[selectedIndex];
    }

    if (world_names?.includes?.(selectedValue)) {
        return selectedValue;
    }

    const selectedName = select.selectedOptions?.[0]?.textContent?.trim();
    return selectedName && world_names?.includes?.(selectedName) ? selectedName : null;
}

function setWorldInfoSearchReplaceBusy(controls, busy) {
    controls.countButton.disabled = busy || controls.findInput.value.length === 0;
    controls.replaceButton.disabled = controls.countButton.disabled;
    controls.findInput.disabled = busy;
    controls.replaceInput.disabled = busy;
    controls.caseInput.disabled = busy;
    controls.countButton.classList.toggle('disabled', busy);
    controls.replaceButton.classList.toggle('disabled', busy);
}

function showWorldInfoSearchReplaceToast(type, message) {
    const toastr = globalThis.toastr;
    const title = koText('ui.459');

    if (typeof toastr?.[type] === 'function') {
        toastr[type](message, title);
        return;
    }

    console[type === 'error' ? 'error' : 'info'](`${title}: ${message}`);
}

export {
    applyWorldInfoSearchReplace,
    confirmWorldInfoSearchReplace,
    countWorldInfoSearchReplaceMatches,
    countWorldInfoSearchReplaceValue,
    createWorldInfoSearchReplaceRegex,
    escapeWorldInfoSearchReplaceCssValue,
    escapeWorldInfoSearchReplaceHtml,
    escapeWorldInfoSearchReplaceRegExp,
    getCurrentWorldInfoEditorName,
    getWorldInfoSearchReplaceQuery,
    getWorldInfoSearchReplaceStats,
    handleWorldInfoSearchReplaceApply,
    handleWorldInfoSearchReplaceCount,
    installWorldInfoSearchReplacePanel,
    refreshWorldInfoSearchReplacePanelControls,
    removeWorldInfoSearchReplacePanel,
    replaceWorldInfoSearchReplaceValue,
    setWorldInfoSearchReplaceBusy,
    showWorldInfoSearchReplaceToast,
    syncRenderedWorldInfoSearchReplaceContent,
};
