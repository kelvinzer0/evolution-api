import { JSONSchema7 } from 'json-schema';

const providerProperty: JSONSchema7 = {
  type: 'string',
  enum: ['baileys', 'browser'],
  description:
    "Fetch backend. 'baileys' (default) uses Baileys protocol-level API. " +
    "'browser' launches a Puppeteer session that fetches via web.whatsapp.com — " +
    'returns full catalog without protocol-level truncation. ' +
    'Requires CATALOG_BROWSER_ENABLED=true and one-time QR/pairing auth per instance.',
};

export const catalogSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    limit: { type: ['number', 'string'] },
    cursor: { type: 'string' },
    provider: providerProperty,
  },
};

export const collectionsSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    limit: { type: ['number', 'string'] },
    cursor: { type: 'string' },
    provider: providerProperty,
  },
};

export const pairingCodeSchema: JSONSchema7 = {
  type: 'object',
  required: ['phone'],
  properties: {
    phone: {
      type: 'string',
      pattern: '^[0-9]+$',
      description: 'Phone number in international format, digits only (e.g. "6285733556953")',
      examples: ['6285733556953'],
    },
  },
};
