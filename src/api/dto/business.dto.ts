export class NumberDto {
  number: string;
}

export class getCatalogDto {
  number?: string;
  limit?: number;
  cursor?: string;
  /**
   * Which fetch backend to use.
   * - `baileys` (default): protocol-level fetch via Baileys library
   * - `browser`: launches a Puppeteer browser session to fetch via
   *   web.whatsapp.com's internal API. Returns full catalog without
   *   WhatsApp's protocol-level truncation. Requires `CATALOG_BROWSER_ENABLED=true`
   *   and the user must complete a one-time QR scan or pairing code for the browser session.
   */
  provider?: 'baileys' | 'browser';
}

export class getCollectionsDto {
  number?: string;
  limit?: number;
  cursor?: string;
  /**
   * Which fetch backend to use. See `getCatalogDto.provider`.
   */
  provider?: 'baileys' | 'browser';
}

export class requestPairingCodeDto {
  /** Phone number in international format, digits only (e.g. "6285733556953" for Indonesia) */
  phone: string;
}
