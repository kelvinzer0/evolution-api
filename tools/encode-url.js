#!/usr/bin/env node
/**
 * Encodes a URL with a fresh random XOR key for the licensing endpoint.
 * Mirrors evolution-go/tools/build-dist/obfuscate.go.
 *
 * Usage:
 *   node tools/encode-url.js <url>
 *
 * Example:
 *   node tools/encode-url.js https://license.evolutionfoundation.com.br
 *
 * Pipe the output into the build:
 *   eval "$(node tools/encode-url.js https://license.evolutionfoundation.com.br)"
 *   npm run build
 */

const crypto = require('node:crypto');

const url = process.argv[2];
if (!url) {
  console.error('usage: node tools/encode-url.js <url>');
  process.exit(2);
}

const urlBytes = Buffer.from(url, 'utf8');
const keyBytes = crypto.randomBytes(urlBytes.length);
const encBytes = Buffer.alloc(urlBytes.length);
for (let i = 0; i < urlBytes.length; i++) {
  encBytes[i] = urlBytes[i] ^ keyBytes[i];
}

const encoded = encBytes.toString('hex');
const key = keyBytes.toString('hex');

// Print eval-friendly export lines.
process.stdout.write(`export LICENSE_ENDPOINT_ENCODED=${encoded}\n`);
process.stdout.write(`export LICENSE_ENDPOINT_XOR_KEY=${key}\n`);
