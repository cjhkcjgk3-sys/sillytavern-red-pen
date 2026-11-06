import { clone } from './core.js';

export class Store {
    constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; }
    async open() {
        this.db = await new Promise((resolve, reject) => {
            const req = this.indexedDB.open('sillytavern-red-pen', 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore('libraries', { keyPath: 'key' });
                req.result.createObjectStore('settings');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('数据库正在被旧页面占用，请关闭旧页面后重试'));
        });
        this.db.onversionchange = () => this.db.close();
    }
    async get(store, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store), req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async all() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('libraries'), req = tx.objectStore('libraries').getAll();
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
    }
    async setting(key, value) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('settings', 'readwrite');
            tx.objectStore('settings').put(value, key);
            tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('设置保存失败'));
        });
    }
    async update(key, initial, mutate) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('libraries', 'readwrite'), store = tx.objectStore('libraries');
            const req = store.get(key);
            let result, exception;
            req.onsuccess = () => {
                try {
                    const lib = clone(req.result ?? initial);
                    result = { value: mutate(lib), library: lib };
                    lib.revision++;
                    store.put(lib);
                } catch (e) { exception = e; tx.abort(); }
            };
            tx.oncomplete = () => resolve(result);
            tx.onabort = tx.onerror = () => reject(exception ?? tx.error ?? new Error('保存失败，内容未更改，请重试'));
        });
    }
    close() { this.db?.close(); }
}
