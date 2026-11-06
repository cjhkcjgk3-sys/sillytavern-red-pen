// Minimal local server for manually inspecting tests/fixture.html in a real
// browser. Mirrors the stubs used by tests/browser.mjs (chat save + generate).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.FIXTURE_PORT ?? 0);

const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
        let text = '';
        for await (const part of req) text += part;
        res.setHeader('Content-Type', 'application/json');
        if (req.url.includes('/generate')) { res.end('{"choices":[{"message":{"content":"测试回复"}}]}'); return; }
        res.end('{"ok":true}');
        return;
    }
    try {
        const path = resolve(root, '.' + (req.url === '/' ? '/tests/fixture.html' : new URL(req.url, 'http://local').pathname));
        const rel = relative(root, path);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('path');
        res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' }[extname(path)] ?? 'application/octet-stream');
        res.end(await readFile(path));
    } catch {
        res.statusCode = 404;
        res.end('not found');
    }
});

await new Promise(done => server.listen(port, '127.0.0.1', done));
console.log(`fixture: http://127.0.0.1:${server.address().port}/tests/fixture.html`);
