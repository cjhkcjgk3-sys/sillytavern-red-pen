import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname,'..');
// Windows resolve() returns backslashes, so compare with relative(), not a prefix.
const inside = target => { const rel = relative(root, target); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const manifest = JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
for (const name of ['display_name','author','version','js']) assert.equal(typeof manifest[name],'string');
assert.match(manifest.version,/^\d+\.\d+\.\d+$/);
for (const path of [manifest.js,manifest.css]) {
    const file=resolve(root,path); assert.ok(inside(file)); assert.ok((await stat(file)).isFile());
}
const entry = await readFile(resolve(root,manifest.js),'utf8');
for (const fn of Object.values(manifest.hooks)) assert.ok(new RegExp(`export (?:async )?function ${fn}\\b`).test(entry));
assert.ok((await readFile(resolve(root,'src/app.js'),'utf8')).includes('globalThis.'+manifest.generate_interceptor));
assert.equal(manifest.version, JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version);
assert.ok(entry.includes(`VERSION = '${manifest.version}'`));
const jsFiles = ['index.js', ...((await readdir(resolve(root,'src'))).filter(x=>x.endsWith('.js')).map(x=>'src/'+x))];
for (const path of jsFiles) {
    execFileSync(process.execPath,['--check',resolve(root,path)]);
    const text=await readFile(resolve(root,path),'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) {
        const specifier=match[2];
        if (specifier.startsWith('/')) { assert.equal(specifier,'/scripts/user.js'); continue; }
        assert.ok(specifier.startsWith('.'),'No runtime npm dependencies: '+specifier);
        const target=resolve(root,path,'..',specifier);assert.ok(inside(target));assert.ok((await stat(target)).isFile());
    }
}
console.log(JSON.stringify({manifest:'通过',hooks:'通过',syntax:jsFiles.map(x=>relative(root,resolve(root,x))),imports:'通过',runtimeNpmDependencies:0},null,2));
