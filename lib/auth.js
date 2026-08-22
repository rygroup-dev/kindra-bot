// auth.js — wallet sign-in. Mirrors the client's loginWithEvm() exactly.
//
// Flow (docs/RE-PROTOCOL.md §3):
//   GET /auth/nonce -> { nonce, issuedAt, domain, uri }
//   message = <byte-exact template>          // server rebuilds & verifies this
//   signature = personal_sign(message)       // EIP-191, secp256k1 — server ecrecovers
//   ws join { auth: { wallet, chain:'evm', nonce, signature } }
//
// The nonce TTL is ~120 s, so fetch it immediately before the join, never at startup.
import { privateKeyToAccount } from 'viem/accounts';

export function accountFromKey(privateKey) {
  if (!privateKey) throw new Error('WALLET_PRIVATE_KEY is not set');
  const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('WALLET_PRIVATE_KEY must be a 32-byte hex key');
  return privateKeyToAccount(pk);
}

export async function fetchNonce(httpOrigin) {
  const res = await fetch(`${httpOrigin}/auth/nonce`, {
    cache: 'no-store',
    headers: { 'accept': 'application/json', 'origin': httpOrigin, 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`/auth/nonce returned HTTP ${res.status}`);
  return res.json();   // { nonce, issuedAt, domain, uri }
}

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// MUST byte-match the server's buildEvmSignInMessage. Do not reformat this string.
export function buildSignInMessage({ domain, address, nonce, issuedAt }) {
  return `Kindra — sign in\n\nThis signature only proves you own this wallet. It authorizes no transactions and moves no funds.\n\nDomain: ${domain}\nWallet: ${address}\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}`;
}

// Returns the `auth` bundle to hand to Net.connect().
// `address` is signed AND sent verbatim — the server rebuilds the message from auth.wallet, so the
// two must be the same string. We use the checksummed form viem gives us for both.
export async function buildAuth(account, httpOrigin) {
  const { nonce, issuedAt, domain } = await fetchNonce(httpOrigin);
  const address = account.address;
  const message = buildSignInMessage({ domain, address, nonce, issuedAt });
  const signature = await account.signMessage({ message });
  return { wallet: address, chain: 'evm', nonce, signature };
}
