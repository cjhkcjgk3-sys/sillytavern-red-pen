// Keep the menu and startup diagnostics independent of core imports. Loading
// failures must leave an entry that the user can open from the native wand.
export const VERSION = '0.1.5';
let instance, startPromise, controlPanel, bootstrapCleanup, hostTimer, generation = 0;
function hasStorage() { try { return !!globalThis.indexedDB; } catch { return false; } }
function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function action(text, run) {
    const node = element('button', text, 'menu_button'); node.type = 'button';
    node.addEventListener('click', () => Promise.resolve().then(run).catch(e => controlPanel?.error(e)));
    return node;
}
export function createControlPanel(retry = initialize) {
    if (controlPanel) return controlPanel;
    const panel = {
        app: null, failure: '',
        update(app = panel.app) {
            panel.app = app;
            if (app) {
                panel.toggle.textContent = app.enabled ? '暂停标记' : '开启标记';
                panel.toggle.setAttribute('aria-pressed', String(app.enabled));
                panel.toggle.disabled = app.canHighlight === false;
                panel.library.textContent = `打开标记库（${app.library?.records.length ?? 0}）`;
                panel.auto.checked = Boolean(app.autoMark);
                panel.auto.disabled = false;
                panel.status.textContent = (app.versionWarning ? '酒馆版本未经验证，基础标记可用。' : '') + (app.enabled ? '标记已开启，当前聊天的有效标记会参与后续请求。' : '标记已暂停，已保存内容仍保留。点击“开启标记”开始使用。');
            }
            panel.inspect();
        },
        inspect() {
            const app = panel.app, diag = app?.selectionDiag;
            const states = { ok: '有效，已显示“标记”', empty: '没有选区', outside: '选区不在聊天正文内', dialog: '有面板打开，暂停响应选区', disabled: '标记已关闭', error: '无法标记' };
            panel.diagnostic.textContent = [
                `插件版本：${VERSION}`,
                `酒馆接口：${typeof globalThis.SillyTavern?.getContext === 'function' ? '已找到' : '尚未找到'}`,
                `酒馆版本：${app?.hostVersion || '未知（未读到 /version）'}${app?.versionWarning ? '（低于验证基线）' : ''}`,
                `持久保存：${hasStorage() ? '浏览器提供' : '不可用'}`,
                `文字高亮：${app ? (app.painter?.native === false ? '兼容模式（叠加层）' : '浏览器原生') : '尚未确定'}`,
                `运行状态：${app ? '已启动' : '尚未启动'}`,
                app ? `标记开关：${app.enabled ? '已开启' : '已暂停'}` : '',
                diag ? `最近选区：${diag.source} · ${states[diag.state] ?? diag.state}${diag.message ? ' · ' + diag.message : ''}` : '最近选区：尚未收到选区事件',
                panel.failure ? `启动失败原因：${panel.failure}` : '',
            ].filter(Boolean).join('\n');
        },
        error(error) {
            panel.failure = error?.message ?? String(error);
            panel.status.textContent = '红笔尚未就绪。请展开“状态检查”查看原因，更新扩展并刷新页面后可重新检查。';
            panel.details.open = true; panel.inspect();
        },
        bind(app) { panel.failure = ''; panel.update(app); },
        unbind() { panel.app = null; panel.inspect(); },
        open() { panel.inspect(); if (!panel.dialog.open) panel.dialog.showModal(); },
        dispose() { panel.observer?.disconnect(); panel.dialog.remove(); panel.menu.remove(); panel.app = null; },
    };
    controlPanel = panel;
    panel.menu = element('div', undefined, 'list-group-item flex-container flexGap5'); panel.menu.id = 'red-pen-menu-item';
    panel.menu.setAttribute('role', 'menuitem'); panel.menu.tabIndex = 0;
    panel.menu.append(element('div', undefined, 'fa-solid fa-highlighter extensionsMenuExtensionButton'), element('span', '红笔标记'));
    panel.menu.addEventListener('click', () => panel.open());
    panel.menu.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); panel.open(); } });
    panel.dialog = element('dialog', undefined, 'rp-library rp-control'); panel.dialog.id = 'red-pen-control'; panel.dialog.setAttribute('aria-label', '红笔标记控制面板');
    Object.assign(panel.dialog.style, { maxWidth: '100vw', maxHeight: '85dvh', overflow: 'auto' });
    const header = element('header'); header.append(element('strong', `红笔标记 v${VERSION}`), action('关闭', () => panel.dialog.close()));
    panel.status = element('p', '正在等待酒馆加载。你可以在这里开启、暂停或打开标记库。', 'rp-state'); panel.status.setAttribute('role', 'status');
    const controls = element('div', undefined, 'rp-row-actions');
    panel.toggle = action('启动并开启标记', async () => { const app = panel.app ?? await retry(); await app.setEnabled(!app.enabled); });
    panel.toggle.setAttribute('aria-pressed', 'false');
    panel.library = action('打开标记库', async () => { const app = panel.app ?? await retry(); await app.ui.open(); });
    // Fallback for hosts where the floating 标记 entry is unreachable.
    panel.mark = action('标记当前选中的文字', async () => {
        const app = panel.app ?? await retry();
        const message = await app.markSelection();
        panel.update(app);
        panel.status.textContent = message;
    });
    const autoWrap = element('label', undefined, 'rp-check');
    panel.auto = document.createElement('input');
    panel.auto.type = 'checkbox';
    panel.auto.disabled = true;
    panel.auto.addEventListener('change', () => {
        Promise.resolve(panel.app?.setAutoMark(panel.auto.checked)).catch(e => panel.error(e));
    });
    autoWrap.append(panel.auto, element('span', '选中即标记（选字后约 1 秒自动保存，少点一次）'));
    controls.append(panel.toggle, panel.library, panel.mark);
    const help = element('p', '开启后，在普通聊天正文中长按选字，拖动系统选区手柄，再点击出现的“标记”。系统复制菜单仍可正常使用。', 'rp-help');
    const scope = element('p', '图片、视频和角色卡内嵌网页暂不支持选字标记。', 'rp-meta');
    panel.details = element('details'); panel.details.append(element('summary', '状态检查'));
    panel.diagnostic = element('pre'); panel.details.append(panel.diagnostic, action('重新检查启动', async () => { const app = await retry(); panel.bind(app); }));
    panel.dialog.append(header, panel.status, controls, autoWrap, help, scope, panel.details); document.body.append(panel.dialog);
    const mount = () => {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;
        menu.append(panel.menu); panel.observer?.disconnect(); return true;
    };
    if (!mount()) { panel.observer = new MutationObserver(mount); panel.observer.observe(document.body, { childList: true, subtree: true }); }
    panel.inspect(); return panel;
}
export async function initialize() {
    if (instance) return instance;
    if (startPromise) return startPromise;
    const panel = createControlPanel(), current = ++generation;
    panel.status.textContent = '正在启动红笔标记…';
    startPromise = (async () => {
        try {
            if (typeof globalThis.SillyTavern?.getContext !== 'function') throw new Error('尚未找到酒馆主页面接口，请等页面加载完成后重新检查');
            const { createApplication } = await import('./src/app.js');
            const app = await createApplication(panel);
            if (current !== generation) { app.dispose(); throw new Error('扩展已停用'); }
            instance = app; panel.bind(app); return app;
        } catch (error) { panel.error(error); console.error('[红笔] 启动失败', error.message); throw error; }
    })();
    try { return await startPromise; } finally { startPromise = null; }
}
export function dispose() {
    generation++; clearTimeout(hostTimer); bootstrapCleanup?.(); bootstrapCleanup = null;
    instance?.dispose(); instance = null; controlPanel?.dispose(); controlPanel = null;
}
function bootstrap(attempt = 0) {
    const panel = createControlPanel();
    const context = globalThis.SillyTavern?.getContext?.();
    const readyEvent = context?.eventTypes?.APP_READY ?? context?.event_types?.APP_READY;
    if (readyEvent && context?.eventSource?.on) {
        const ready = () => { bootstrapCleanup?.(); bootstrapCleanup = null; initialize().catch(() => {}); };
        bootstrapCleanup = () => context.eventSource.removeListener(readyEvent, ready);
        context.eventSource.on(readyEvent, ready);
    } else if (attempt < 150) hostTimer = setTimeout(() => bootstrap(attempt + 1), 200);
    else panel.error(new Error('等待酒馆接口超时，请刷新页面后在魔术棒的“红笔标记”中重新检查'));
}
if (!globalThis.__RED_PEN_TEST__) {
    if (document.body) bootstrap();
    else document.addEventListener('DOMContentLoaded', () => bootstrap(), { once: true });
}
