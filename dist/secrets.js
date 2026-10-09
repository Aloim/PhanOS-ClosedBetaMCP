// cyphor-role: IO
import { readFile, rm } from 'node:fs/promises';
import { writeFileAtomic } from './fsutil.js';
const SERVICE = 'phanos';
export class FileSecretStore {
    where;
    kind = 'file';
    constructor(where) {
        this.where = where;
    }
    async get() {
        try {
            const { session } = JSON.parse(await readFile(this.where, 'utf8'));
            return session ?? null;
        }
        catch {
            return null;
        }
    }
    async set(value) {
        await writeFileAtomic(this.where, JSON.stringify({ session: value }), 0o600);
    }
    async clear() {
        await rm(this.where, { force: true });
    }
}
class KeyringSecretStore {
    entry;
    where;
    kind = 'keyring';
    constructor(entry, where) {
        this.entry = entry;
        this.where = where;
    }
    async get() {
        return this.entry.getPassword() ?? null;
    }
    async set(value) {
        this.entry.setPassword(value);
    }
    async clear() {
        try {
            this.entry.deletePassword();
        }
        catch {
            /* already absent */
        }
    }
}
async function defaultKeyringFactory() {
    const { Entry } = await import('@napi-rs/keyring');
    return (service, account) => new Entry(service, account);
}
export async function createSecretStore(opts) {
    const account = `session:${opts.apiBase}`;
    try {
        const factory = opts.keyringFactory ?? (await defaultKeyringFactory());
        const entry = factory(SERVICE, account);
        entry.getPassword(); // probe: throws when no keyring backend exists
        return new KeyringSecretStore(entry, `OS credential store (${SERVICE} / ${account})`);
    }
    catch {
        return new FileSecretStore(opts.paths.sessionFile);
    }
}
