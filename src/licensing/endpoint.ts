// Mirrors evolution-go/pkg/core/endpoint.go
//
// The licensing URL is **build-time only** — it gets baked into the bundle by
// tsup's `define` so the operator cannot point the running service at a
// different licensing server via env vars.
//
// In release builds the Dockerfile passes:
//   LICENSE_ENDPOINT_ENCODED=<hex>   (XOR-encoded URL)
//   LICENSE_ENDPOINT_XOR_KEY=<hex>   (XOR key)
//
// Use `node tools/encode-url.js https://license.evolutionfoundation.com.br`
// to generate the pair.
//
// In dev (vars empty), the URL is reconstructed from a parts array — same
// technique as evolution-go.

// These two identifiers are replaced at bundle time by tsup `define`.
// Do NOT inline them or read them from process.env — see tsup.config.ts.
declare const __LICENSE_ENDPOINT_ENCODED__: string;
declare const __LICENSE_ENDPOINT_XOR_KEY__: string;

const encodedEP = typeof __LICENSE_ENDPOINT_ENCODED__ === 'string' ? __LICENSE_ENDPOINT_ENCODED__ : '';
const xorKey = typeof __LICENSE_ENDPOINT_XOR_KEY__ === 'string' ? __LICENSE_ENDPOINT_XOR_KEY__ : '';

export function resolveEndpoint(): string {
  if (encodedEP && xorKey) {
    return decodeXOR(encodedEP, xorKey);
  }
  // Dev fallback — assembled at runtime, not a single string literal.
  const parts = [
    'h',
    'tt',
    'ps',
    '://',
    'li',
    'ce',
    'nse',
    '.',
    'ev',
    'ol',
    'ut',
    'io',
    'nf',
    'ou',
    'nd',
    'at',
    'io',
    'n.',
    'co',
    'm.',
    'br',
  ];
  return parts.join('');
}

function decodeXOR(enc: string, key: string): string {
  const encBytes = hexDec(enc);
  const keyBytes = hexDec(key);
  if (keyBytes.length === 0) return '';
  const out = Buffer.alloc(encBytes.length);
  for (let i = 0; i < encBytes.length; i++) {
    out[i] = encBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return out.toString('utf8');
}

function hexDec(s: string): Buffer {
  if (s.length % 2 !== 0) return Buffer.alloc(0);
  return Buffer.from(s, 'hex');
}
