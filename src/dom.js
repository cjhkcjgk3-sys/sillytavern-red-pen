import { fingerprint } from './core.js';

const excluded = 'button,script,style,textarea,input,select,iframe,video,audio,svg,img,[hidden],[aria-hidden="true"],.mes_reasoning,.reasoning,.hljs-copy-button,.code-copy,.code-copy-button,.fa,.fas,.fa-solid';
const blocks = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|DIV|TR)$/;
function hidden(el) {
    const style = getComputedStyle(el);
    return el.matches(excluded) || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
}
// A projection maps visible characters to DOM boundaries without modifying nodes.
export function project(root) {
    const units = [];
    function newline(count) {
        if (!units.length) return;
        let have = 0;
        for (let i = units.length - 1; i >= 0 && units[i].virtual; i--) have++;
        for (; have < count; have++) units.push({ text: '\n', virtual: true });
    }
    function walk(el, pre = false) {
        if (el.nodeType === Node.TEXT_NODE) {
            const value = el.data;
            for (let i = 0; i < value.length;) {
                const start = i;
                let text = value[i++];
                if (!pre && /\s/.test(text)) {
                    while (i < value.length && /\s/.test(value[i])) i++;
                    text = ' ';
                    if (!units.length || units.at(-1).text === ' ' || units.at(-1).virtual) continue;
                }
                units.push({ text, node: el, start, end: i });
            }
            return;
        }
        if (el.nodeType !== Node.ELEMENT_NODE || hidden(el)) return;
        if (el.tagName === 'DETAILS' && !el.open) {
            const summary = el.querySelector(':scope > summary');
            if (summary) walk(summary, pre);
            return;
        }
        if (el.tagName === 'BR') { newline(1); return; }
        const isBlock = blocks.test(el.tagName) && el !== root;
        if (isBlock) newline(el.tagName === 'LI' ? 1 : 2);
        const preserve = pre || el.tagName === 'PRE' || /^(pre|pre-wrap|break-spaces)$/.test(getComputedStyle(el).whiteSpace);
        for (const child of el.childNodes) walk(child, preserve);
        if (isBlock) newline(el.tagName === 'LI' ? 1 : 2);
    }
    walk(root);
    while (units.at(-1)?.virtual) units.pop();
    const text = units.map(u => u.text).join('');
    return { units, text, hash: fingerprint(text) };
}
function compare(node, offset, otherNode, otherOffset) {
    const a = document.createRange(), b = document.createRange();
    a.setStart(node, offset); a.collapse(true);
    b.setStart(otherNode, otherOffset); b.collapse(true);
    return a.compareBoundaryPoints(Range.START_TO_START, b);
}
export function rangeFor(projection, start, end) {
    const first = projection.units.slice(start, end).find(u => !u.virtual);
    const last = projection.units.slice(start, end).findLast(u => !u.virtual);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, first.start); range.setEnd(last.node, last.end);
    return range;
}
export function captureSelection(selection = window.getSelection()) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const parent = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const root = parent(range.startContainer)?.closest('.mes_text');
    if (!root || parent(range.endContainer)?.closest('.mes_text') !== root) throw new Error('请在同一条消息的正文内选字，跨消息的片段请分别标记');
    const forbidden = parent(range.startContainer)?.closest(excluded) || parent(range.endContainer)?.closest(excluded);
    if (forbidden) throw new Error('这里的内容暂不支持准确标记，请选择普通正文');
    const cells = [...root.querySelectorAll('td,th')].filter(c => range.intersectsNode(c));
    if (cells.length && (cells.length !== 1 || !cells[0].contains(range.startContainer) || !cells[0].contains(range.endContainer))) throw new Error('表格仅支持单个单元格内选字');
    const projection = project(root);
    let start = -1, end = -1;
    projection.units.forEach((u, i) => {
        if (!u.virtual && compare(u.node, u.end, range.startContainer, range.startOffset) > 0 && compare(u.node, u.start, range.endContainer, range.endOffset) < 0) {
            if (start < 0) start = i;
            end = i + 1;
        }
    });
    if (start < 0 || end <= start) throw new Error('没有可标记的可见正文');
    // Boundary text nodes may collapse multiple whitespace characters; reject a
    // partial collapsed run rather than guessing what was selected.
    const first = projection.units[start], last = projection.units[end - 1];
    if (compare(first.node, first.start, range.startContainer, range.startOffset) < 0 || compare(last.node, last.end, range.endContainer, range.endOffset) > 0) throw new Error('选区边界处的空白无法准确识别，请调整选区后重试');
    return { root, range, projection: projection.hash, start, end, text: projection.text.slice(start, end), index: Number(root.closest('.mes')?.getAttribute('mesid')) };
}

export class Painter {
    constructor() { this.entries = []; }
    clear() { globalThis.CSS?.highlights?.delete('red-pen'); this.entries = []; }
    paint(entries) {
        this.clear();
        if (!entries.length) return;
        CSS.highlights.set('red-pen', new Highlight(...entries.map(e => e.range)));
        this.entries = entries;
    }
    hit(x, y) {
        return this.entries.find(({ range }) => [...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
    }
}
