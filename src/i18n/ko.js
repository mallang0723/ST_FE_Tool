import catalog from './catalog.json' with { type: 'json' };
export function txt(key, variables = {}) {
    return (catalog[key]?.ko ?? key).replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? `{${name}}`));
}
export function localizeSettings(html) {
    const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    return html.replace(/\{\{ko:([\w.]+)\}\}/g, (_, key) => escape(txt(key)));
}
