// cyphor-role: DATA
export interface TrustedKey {
  kid: string;
  publicPem: string;
}

/**
 * Public halves of the OFFLINE release signing keys (tools/release `pnpm keygen`).
 * A key here lets a manifest pass verification, so add keys only from the owner's keygen output.
 * NEVER put a private key here.
 */
export const TRUSTED_RELEASE_KEYS: TrustedKey[] = [
  {
    kid: '2026-10',
    publicPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAkxVQr5lBgHgZ9E0z/EwYVJezYjRzidkOX3tZh+6QxA=\n-----END PUBLIC KEY-----\n',
  },
];
