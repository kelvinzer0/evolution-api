/**
 * Type definitions for the browser-based catalog service.
 *
 * The BrowserCatalogService is a singleton that lazily launches a Puppeteer
 * browser per WhatsApp account (identified by JID) to fetch catalog &
 * collections via the internal `window.WPP.whatsapp.functions.queryCatalog`
 * API of web.whatsapp.com — bypassing the limitations of Baileys' protocol
 * level `getCatalog()` implementation.
 *
 * Why: WhatsApp's anti-bot/anti-scraping is very strict on the protocol
 * level (Baileys), but relaxed on the browser level (whatsapp-web.js /
 * direct WA Web access). Bedones-whatsapp proved this approach works for
 * fetching full catalogs.
 */

/**
 * Catalog product as returned by the browser fetch path.
 * Shape mirrors Baileys' `Product` type for API response compatibility.
 */
export interface BrowserProduct {
  id: string;
  name?: string;
  description?: string;
  currency?: string;
  price?: number;
  imageCdnUrl?: string;
  image_cdn_url?: string;
  image_cdn_urls?: Array<{ key: string; value: string }>;
  additionalImageCdnUrl?: string[];
  additional_image_cdn_urls?: Array<Array<{ key: string; value: string }>>;
  retailerId?: string;
  retailer_id?: string;
  url?: string;
  isHidden?: boolean;
  availability?: string;
  [key: string]: unknown;
}

/**
 * Catalog collection as returned by the browser fetch path.
 * Shape mirrors Baileys' `CatalogCollection` type.
 */
export interface BrowserCollection {
  id: string;
  name: string;
  products: BrowserProduct[];
  status?: string;
  [key: string]: unknown;
}

/**
 * Options for fetching catalog via the browser path.
 */
export interface BrowserCatalogOptions {
  /** JID of the WhatsApp Business account whose catalog to fetch */
  jid: string;
  /** Instance name (used for session file path isolation) */
  instanceName: string;
  /** Optional: max number of products per pagination call (default 50) */
  pageSize?: number;
  /** Optional: max number of pagination loops before stopping (default 200) */
  maxLoops?: number;
}

/**
 * Options for fetching collections via the browser path.
 */
export interface BrowserCollectionsOptions {
  /** JID of the WhatsApp Business account */
  jid: string;
  /** Instance name */
  instanceName: string;
  /** Optional: limit */
  limit?: number;
}

/**
 * Result of a catalog fetch operation.
 */
export interface BrowserCatalogResult {
  wuid: string;
  numberExists: boolean;
  isBusiness: boolean;
  catalogLength: number;
  catalog: BrowserProduct[];
  truncated: boolean;
  nextCursor: string | null;
  source: 'browser';
}

/**
 * Result of a collections fetch operation.
 */
export interface BrowserCollectionsResult {
  wuid: string;
  name: string | null;
  numberExists: boolean;
  isBusiness: boolean;
  collectionsLength: number;
  collections: BrowserCollection[];
  source: 'browser';
  /** Diagnostic info about wa-js webpack modules available */
  diagnostic?: any;
  /** Per-collection debug info: which method worked, product count, attempts */
  perCollectionDebug?: Array<{
    collectionId: string;
    collectionName?: string;
    productCount: number;
    method: string;
    attempts?: any[];
  }>;
  /** Total products mapped across all collections */
  totalProductsMapped?: number;
}

/**
 * Result of the hybrid collections fetch (browser metadata + Baileys product mapping).
 *
 * Each collection's `products` array is populated from Baileys' protocol-level
 * `getCollections` IQ stanza (which returns products nested in each collection).
 * If Baileys fails (anti-bot / not-business), `products` arrays will be empty
 * and `baileysOk` will be false — caller should fall back to keyword matching.
 */
export interface HybridCollectionsResult extends Omit<BrowserCollectionsResult, 'source'> {
  source: 'hybrid';
  /** Number of collections Baileys returned (may be 0 if anti-bot blocked it) */
  baileysCollectionsCount: number;
  /** Total number of products across all collections from Baileys */
  baileysProductsCount: number;
  /** Whether the Baileys protocol query succeeded */
  baileysOk: boolean;
}

/**
 * Internal state of a browser session.
 */
export interface BrowserSessionState {
  /** JID of the WhatsApp account */
  jid: string;
  /** Instance name */
  instanceName: string;
  /** Whether the browser is authenticated */
  authenticated: boolean;
  /** QR code data URL, if pending authentication */
  qrCode?: string;
  /** Timestamp of last activity (ms epoch) */
  lastActivity: number;
  /** Timestamp of session creation */
  createdAt: number;
}

/**
 * Configuration for the BrowserCatalogService.
 */
export interface BrowserCatalogConfig {
  /** Master toggle — if false, all browser calls fall back to Baileys */
  enabled: boolean;
  /** Idle timeout before killing browser (ms) */
  idleTimeoutMs: number;
  /** Max concurrent browser sessions */
  maxSessions: number;
  /** Headless mode (true | false | 'shell' in Puppeteer v23+) */
  headless: boolean | 'shell';
  /** Custom executable path (overrides PUPPETEER_EXECUTABLE_PATH env) */
  executablePath?: string;
  /** Extra Puppeteer launch args */
  extraArgs?: string[];
}
