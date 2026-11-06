import { fingerprint } from './core.js';

const excluded = 'button,script,style,textarea,input,select,iframe,video,audio,svg,img,[hidden],[aria-hidden="true"],.mes_reasoning,.reasoning,.hljs-copy-button,.code-copy,.code-copy-button,.fa,.fas,.fa-solid';
const blocks = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|DIV|TR)$/;
const blank = value => !/[^\s]/.test(value ?? '');
function hidden(el) {
    const style = getComputedStyle(el);
    return el.matches(excluded) || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
}
/** Element-or-text node -> the `.mes_text` it belongs to. Touch selections can
 * anchor on an element boundary, so `.parentElement` alone is not enough. */
export function messageRootOf(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.('.mes_text') ?? null;
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
                    const previous = units[units.length - 1];
                    if (!previous || previous.text === ' ' || previous.virtual) continue;
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
    while (units[units.length - 1]?.virtual) units.pop();
    const text = units.map(u => u.text).join('');
    return { units, text, hash: fingerprint(text) };
}
/** Drop blank units at the edges the caller could not align exactly. Touch
 * handle drags routinely end inside the spaces/newlines around a paragraph;
 * those are not part of what the user means to mark. An aligned edge is never
 * trimmed, so selected code keeps its indentation. */
export function trimBlankEdges(units, start, end, { head = true, tail = true } = {}) {
    while (head && start < end && blank(units[start]?.text)) start++;
    while (tail && end > start && blank(units[end - 1]?.text)) end--;
    return { start, end };
}
function compare(node, offset, otherNode, otherOffset) {
    const a = document.createRange(), b = document.createRange();
    a.setStart(node, offset); a.collapse(true);
    b.setStart(otherNode, otherOffset); b.collapse(true);
    return a.compareBoundaryPoints(Range.START_TO_START, b);
}
export function rangeFor(projection, start, end) {
    const first = projection.units.slice(start, end).find(u => !u.virtual);
    let last;
    for (let i = end - 1; i >= start; i--) { if (!projection.units[i].virtual) { last = projection.units[i]; break; } }
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, first.start); range.setEnd(last.node, last.end);
    return range;
}
export function captureSelection(selection = window.getSelection()) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const parent = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const root = messageRootOf(range.startContainer);
    if (!root || messageRootOf(range.endContainer) !== root) throw new Error('请在同一条消息的正文内选字，跨消息的片段请分别标记');
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
    const aligned = (s, e) => {
        if (s < 0 || e <= s) return false;
        const first = projection.units[s], last = projection.units[e - 1];
        return compare(first.node, first.start, range.startContainer, range.startOffset) >= 0
            && compare(last.node, last.end, range.endContainer, range.endOffset) <= 0;
    };
    // Exact boundaries keep code indentation and paragraph breaks untouched.
    if (!aligned(start, end)) {
        const headBad = compare(projection.units[start].node, projection.units[start].start, range.startContainer, range.startOffset) < 0;
        const tailBad = compare(projection.units[end - 1].node, projection.units[end - 1].end, range.endContainer, range.endOffset) > 0;
        const trimmed = trimBlankEdges(projection.units, start, end, { head: headBad, tail: tailBad });
        if (!aligned(trimmed.start, trimmed.end)) throw new Error('选区边界处的空白无法准确识别，请调整选区后重试');
        start = trimmed.start; end = trimmed.end;
    }
    const index = Number(root.closest('.mes')?.getAttribute('mesid'));
    if (!Number.isInteger(index)) throw new Error('未找到这条消息的来源标识，请刷新后重试');
    return { root, range, projection: projection.hash, start, end, text: projection.text.slice(start, end), index };
}

/** Paints marked ranges. Uses the CSS Custom Highlight API when the browser
 * has it, otherwise a pointer-events:none overlay of positioned rectangles —
 * the chat DOM is never modified either way. */
export class Painter {
    constructor({ native } = {}) {
        this.native = native ?? !!(globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function');
        this.entries = [];
        this.layer = null;
    }
    clear() {
        if (this.native) globalThis.CSS?.highlights?.delete?.('red-pen');
        if (this.layer) this.layer.replaceChildren();
        this.entries = [];
    }
    paint(entries) {
        this.clear();
        if (!entries.length) return;
        this.entries = entries;
        if (this.native) {
            CSS.highlights.set('red-pen', new Highlight(...entries.map(e => e.range)));
            return;
        }
        if (!this.layer) this.mount();
        this.draw();
    }
    mount() {
        const layer = document.createElement('div');
        layer.className = 'rp-overlay';
        layer.setAttribute('aria-hidden', 'true');
        document.body.append(layer);
        this.layer = layer;
        this.redraw = () => this.draw();
        globalThis.addEventListener?.('scroll', this.redraw, { capture: true, passive: true });
        globalThis.addEventListener?.('resize', this.redraw, { passive: true });
        return layer;
    }
    draw() {
        if (!this.layer) return;
        const layer = this.layer;
        const height = globalThis.innerHeight ?? 0;
        const fragment = document.createDocumentFragment();
        let count = 0;
        for (const { range } of this.entries) {
            for (const rect of range.getClientRects()) {
                if (!rect.width || !rect.height || count >= 800) continue;
                if (rect.bottom < -8 || rect.top > height + 8) continue;
                const mark = document.createElement('i');
                mark.style.left = `${rect.left}px`;
                mark.style.top = `${rect.top}px`;
                mark.style.width = `${rect.width}px`;
                mark.style.height = `${rect.height}px`;
                fragment.append(mark);
                count++;
            }
        }
        layer.replaceChildren(fragment);
    }
    hit(x, y) {
        return this.entries.find(({ range }) => [...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
    }
    dispose() {
        this.clear();
        this.layer?.remove();
        this.layer = null;
        if (this.redraw) {
            globalThis.removeEventListener?.('scroll', this.redraw, { capture: true });
            globalThis.removeEventListener?.('resize', this.redraw);
            this.redraw = null;
        }
    }
}
