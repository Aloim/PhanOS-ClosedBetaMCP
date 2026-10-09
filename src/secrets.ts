// cyphor-role: IO
import { readFile, rm } from 'node:fs/promises';
import type { Paths } from './config.js';
import { writeFileAtomic } from './fsutil.js';

export interface SecretStore {
  readonly kind: 'keyring' | 'file';
  readonly where: string;
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(v: string): void;
  deletePassword(): boolean | void;
}

const SERVICE = 'phanos';

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  constructor(readonly where: string) {}
  async get() {
    try {
      const { session } = JSON.parse(await readFile(this.where, 'utf8')) as { session?: string };
      return session ?? null;
    } catch {
      return null;
    }
  }
  async set(value: string) {
    await writeFileAtomic(this.where, JSON.stringify({ session: value }), 0o600);
  }
  async clear() {
    await rm(this.where, { force: true });
  }
}

class KeyringSecretStore implements SecretStore {
  readonly kind = 'keyring' as const;
  constructor(private readonly entry: KeyringEntry, readonly where: string) {}
  async get() {
    return this.entry.getPassword() ?? null;
  }
  async set(value: string) {
    this.entry.setPassword(value);
  }
  async clear() {
    try {
      this.entry.deletePassword();
    } catch {
      /* already absent */
    }
  }
}

async function defaultKeyringFactory(): Promise<(service: string, account: string) => KeyringEntry> {
  const { Entry } = await import('@napi-rs/keyring');
  return (service, account) => new Entry(service, account);
}

export async function createSecretStore(opts: {
  paths: Paths;
  apiBase: string;
  keyringFactory?: (service: string, account: string) => KeyringEntry;
}): Promise<SecretStore> {
  const account = `session:${opts.apiBase}`;
  try {
    const factory = opts.keyringFactory ?? (await defaultKeyringFactory());
    const entry = factory(SERVICE, account);
    entry.getPassword(); // probe: throws when no keyring backend exists
    return new KeyringSecretStore(entry, `OS credential store (${SERVICE} / ${account})`);
  } catch {
    return new FileSecretStore(opts.paths.sessionFile);
  }
}
