/**
 * BrowserCatalogService
 * ---------------------------------------------------------------------
 * Singleton service that uses whatsapp-web.js to fetch catalog & collections
 * via web.whatsapp.com, bypassing Baileys' protocol-level truncation.
 *
 * Why this exists:
 *   WhatsApp's anti-bot/anti-scraping on the protocol level (Baileys) is
 *   very strict and causes `getCatalog()` to truncate results. The same
 *   catalog fetched via web.whatsapp.com (browser automation) returns the
 *   full list because WhatsApp's own frontend code handles pagination.
 *
 * Implementation:
 *   Uses whatsapp-web.js (same library as bedones-whatsapp, proven working).
 *   - LocalAuth strategy for session persistence per instance
 *   - Event-driven: 'qr', 'authenticated', 'ready', 'code_received' (pairing)
 *   - Catalog fetch uses window.WPP API (auto-injected by whatsapp-web.js)
 *
 * Ported logic from:
 *   bedones-whatsapp/apps/whatsapp-connector/src/catalog/catalog.service.ts
 */

import { Logger } from '@config/logger.config';
import { INSTANCE_DIR } from '@config/path.config';
import { BadRequestException } from '@exceptions';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Client, LocalAuth } from 'whatsapp-web.js';

import {
  BrowserCatalogConfig,
  BrowserCatalogOptions,
  BrowserCatalogResult,
  BrowserCollectionsOptions,
  BrowserCollectionsResult,
} from './catalog-browser.types';

// Per-instance client state
interface InstanceClientState {
  client: Client;
  ready: boolean;
  readyPromise: Promise<void>;
  qrCode: string | null;
  pairingCode: string | null;
  lastActivity: number;
  idleTimer?: NodeJS.Timeout;
}

const SESSION_SUBDIR = 'browser-session';

// (No NestJS — Evolution API uses plain classes. The @Injectable decorator
//  below is a no-op kept only for documentation purposes; remove if it causes
//  issues. This class is constructed manually in server.module.ts.)

export class BrowserCatalogService {
  private readonly logger = new Logger(BrowserCatalogService.name);
  private readonly config: BrowserCatalogConfig;

  // Per-instance state map (key = instance name)
  private readonly clients = new Map<string, InstanceClientState>();

  private static instance: BrowserCatalogService | null = null;

  static getInstance(): BrowserCatalogService | null {
    return BrowserCatalogService.instance;
  }

  static setInstance(svc: BrowserCatalogService): void {
    BrowserCatalogService.instance = svc;
  }

  constructor() {
    this.config = this.loadConfig();
    if (this.config.enabled) {
      this.logger.log(
        `Browser catalog service enabled (maxSessions=${this.config.maxSessions}, idleTimeoutMs=${this.config.idleTimeoutMs})`,
      );
    }
    BrowserCatalogService.setInstance(this);
  }

  static async fetchCatalogOrThrow(options: BrowserCatalogOptions): Promise<BrowserCatalogResult> {
    const svc = BrowserCatalogService.getInstance();
    if (!svc) {
      throw new BadRequestException(
        'Browser catalog service is not initialized. Set CATALOG_BROWSER_ENABLED=true to enable.',
      );
    }
    return svc.fetchCatalog(options);
  }

  static async fetchCollectionsOrThrow(options: BrowserCollectionsOptions): Promise<BrowserCollectionsResult> {
    const svc = BrowserCatalogService.getInstance();
    if (!svc) {
      throw new BadRequestException(
        'Browser catalog service is not initialized. Set CATALOG_BROWSER_ENABLED=true to enable.',
      );
    }
    return svc.fetchCollections(options);
  }

  /**
   * Static wrapper for fetchCollectionProductsFallback.
   * Called by whatsapp.baileys.service.ts when Baileys returns 0 products.
   */
  static async fetchCollectionProductsFallback(options: {
    instanceName: string;
    collectionIds: Array<{ id: string; name?: string }>;
    productsPerCollection: number;
  }): Promise<{
    productsByCollectionId: Array<{
      collectionId: string;
      collectionName?: string;
      products: any[];
      method: string;
      error?: string;
      attempts?: any[];
    }>;
    diagnostic?: any;
  }> {
    const svc = BrowserCatalogService.getInstance();
    if (!svc) {
      throw new BadRequestException(
        'Browser catalog service is not initialized. Set CATALOG_BROWSER_ENABLED=true to enable.',
      );
    }
    return svc.fetchCollectionProductsFallback(options);
  }

  private loadConfig(): BrowserCatalogConfig {
    const enabled = (process.env.CATALOG_BROWSER_ENABLED || 'false').toLowerCase() === 'true';
    const idleTimeoutMs = parseInt(process.env.CATALOG_BROWSER_IDLE_TIMEOUT_MS || '600000', 10);
    const maxSessions = parseInt(process.env.CATALOG_BROWSER_MAX_SESSIONS || '5', 10);
    const headlessEnv = (process.env.CATALOG_BROWSER_HEADLESS || 'true').toLowerCase();
    const headless: boolean | 'shell' = headlessEnv === 'shell' ? 'shell' : headlessEnv === 'false' ? false : true;
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';

    return {
      enabled,
      idleTimeoutMs,
      maxSessions,
      headless,
      executablePath,
      extraArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-features=VizDisplayCompositor,Vulkan',
        '--disable-vulkan',
        '--memory-pressure-off',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-default-apps',
        '--disable-component-update',
        '--disable-blink-features=AutomationControlled',
      ],
    };
  }

  /**
   * Get the user-data directory for an instance's WhatsApp Web session.
   */
  private userDataDir(instanceName: string): string {
    return join(INSTANCE_DIR, instanceName, SESSION_SUBDIR);
  }

  /**
   * Sanitize an instance name into a valid LocalAuth clientId.
   *
   * whatsapp-web.js LocalAuth requires clientId to be alphanumeric + underscore
   * + hyphen only. Instance names like "Warung Lakku" (with space) are rejected
   * with "Invalid clientId" error.
   *
   * Strategy: replace any non-alphanumeric char with a hyphen, collapse
   * consecutive hyphens, and trim leading/trailing hyphens.
   *
   * Examples:
   *   "Warung Lakku"     → "Warung-Lakku"
   *   "kelvincruv"       → "kelvincruv"
   *   "Hobi Haus"        → "Hobi-Haus"
   *   "My Instance #1!"  → "My-Instance-1"
   */
  private sanitizeClientId(instanceName: string): string {
    return instanceName
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Clean stale Chromium lock files left by previous crashed sessions.
   */
  private cleanStaleLocks(dir: string): void {
    for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = join(dir, lockFile);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
          this.logger.log(`[browser] Removed stale lock: ${lockFile}`);
        } catch (err) {
          this.logger.warn(`[browser] Failed to remove ${lockFile}: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * Inject @wppconnect/wa-js into the WhatsApp Web page.
   *
   * whatsapp-web.js does NOT auto-inject wa-js. Without it, window.WPP is
   * undefined and all catalog/collection fetch logic fails silently.
   *
   * This reads the wa-js bundle from node_modules and evaluates it in the
   * page context, then waits for WPP.isReady.
   *
   * (Ported from bedones-whatsapp's injectWPPIntoPageInternal)
   */
  private async injectWaJs(page: any): Promise<void> {
    const wppExists = await page.evaluate(() => typeof (window as any).WPP !== 'undefined');
    if (wppExists) {
      this.logger.log('[browser] WPP already loaded in page');
      // Still ensure it's ready
      await this.waitForWppReady(page);
      return;
    }

    this.logger.log('[browser] Injecting @wppconnect/wa-js into page...');
    // require.resolve is needed because @wppconnect/wa-js doesn't export a path
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const waJsPath = require.resolve('@wppconnect/wa-js');
    const waJsCode = readFileSync(waJsPath, 'utf8');
    await page.evaluate(waJsCode);
    this.logger.log(`[browser] wa-js injected (${waJsCode.length} chars)`);

    // Wait for window.WPP to be defined (the library object)
    try {
      await page.waitForFunction(() => typeof (window as any).WPP !== 'undefined', { timeout: 10000 });
      this.logger.log('[browser] window.WPP is defined');
    } catch {
      this.logger.warn('[browser] window.WPP not defined after 10s — wa-js injection may have failed');
      throw new BadRequestException('Failed to inject wa-js: window.WPP not defined');
    }

    // Wait for WPP to be fully ready (webpack modules loaded)
    await this.waitForWppReady(page);
  }

  /**
   * Wait for WPP.isReady === true using Puppeteer's waitForFunction polling.
   *
   * Verified working in production: isReady becomes true within ~3s of
   * wa-js injection. The onFullReady/onReady callbacks from wa-js are
   * NOT available on window.WPP object (confirmed via debug script),
   * so polling via waitForFunction is the most reliable approach.
   *
   * Without waiting, calling WPP.conn.getMyUserId() crashes with
   * "Cannot read properties of undefined (reading 'm')" because the
   * underlying webpack module isn't loaded yet.
   */
  private async waitForWppReady(page: any): Promise<void> {
    this.logger.log('[browser] Waiting for WPP.isReady...');

    try {
      await page.waitForFunction(
        () => {
          const wpp = (window as any).WPP;
          return wpp && (wpp.isReady === true || wpp.isFullReady === true);
        },
        { timeout: 60000, polling: 500 },
      );
      this.logger.log('[browser] WPP.isReady = true');
    } catch {
      // Check final state for debugging
      const state = await page
        .evaluate(() => {
          const wpp = (window as any).WPP;
          return {
            exists: !!wpp,
            isReady: wpp?.isReady,
            isFullReady: wpp?.isFullReady,
          };
        })
        .catch(() => ({ exists: false, isReady: false, isFullReady: false }));

      this.logger.warn(
        `[browser] WPP NOT ready after 60s (exists=${state.exists}, isReady=${state.isReady}, isFullReady=${state.isFullReady})`,
      );
      throw new BadRequestException(
        'WPP library not ready after 60s. WhatsApp Web may have changed its internal structure.',
      );
    }
  }

  /**
   * Get or create a Client for the given instance.
   * Returns once the client is fully ready (authenticated + WA Web loaded).
   */
  private async getReadyClient(instanceName: string): Promise<InstanceClientState> {
    let state = this.clients.get(instanceName);
    if (state) {
      // Reset idle timer
      this.resetIdleTimer(instanceName);
      await state.readyPromise;
      return state;
    }

    // Evict oldest if at capacity
    if (this.clients.size >= this.config.maxSessions) {
      const oldest = Array.from(this.clients.entries()).sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
      if (oldest) {
        this.logger.warn(`[browser] Max sessions reached, evicting: ${oldest[0]}`);
        await this.killClient(oldest[0]);
      }
    }

    state = this.launchClient(instanceName);
    this.clients.set(instanceName, state);
    this.resetIdleTimer(instanceName);
    await state.readyPromise;
    return state;
  }

  /**
   * Launch a new whatsapp-web.js Client for the instance.
   * Sets up event listeners for qr / authenticated / ready / disconnected.
   */
  private launchClient(instanceName: string): InstanceClientState {
    const userDataDir = this.userDataDir(instanceName);
    mkdirSync(userDataDir, { recursive: true });
    this.cleanStaleLocks(userDataDir);

    this.logger.log(`[browser] Launching Client for instance=${instanceName}`);

    const state: InstanceClientState = {
      client: null as any,
      ready: false,
      readyPromise: null as any,
      qrCode: null,
      pairingCode: null,
      lastActivity: Date.now(),
    };

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.sanitizeClientId(instanceName),
        dataPath: userDataDir,
      }),
      puppeteer: {
        executablePath: this.config.executablePath,
        headless: this.config.headless,
        args: this.config.extraArgs,
        bypassCSP: true,
      },
    });
    state.client = client;

    // Set up event listeners
    client.on('qr', (qr: string) => {
      this.logger.log(`[browser] QR received for instance=${instanceName}`);
      state.qrCode = qr;
      state.pairingCode = null;
    });

    client.on('authenticated', () => {
      this.logger.log(`[browser] Authenticated for instance=${instanceName}`);
      state.qrCode = null;
      state.pairingCode = null;
    });

    client.on('ready', () => {
      this.logger.log(`[browser] Client ready for instance=${instanceName}`);
      state.ready = true;
      state.qrCode = null;
      state.pairingCode = null;
      // Note: wa-js injection is done lazily in fetchCatalog/fetchCollections,
      // NOT here. Calling injectWaJs here causes a race condition with the
      // injectWaJs call in fetchCatalog — two concurrent page.evaluate(waJsCode)
      // calls corrupt the page state, resulting in window.WPP = undefined.
    });

    client.on('auth_failure', (msg: string) => {
      this.logger.error(`[browser] Auth failure for instance=${instanceName}: ${msg}`);
    });

    client.on('disconnected', (reason: string) => {
      this.logger.warn(`[browser] Disconnected for instance=${instanceName}: ${reason}`);
      this.clients.delete(instanceName);
    });

    // Create readyPromise that resolves when EITHER 'qr' OR 'ready' event fires.
    // - 'qr' means client needs authentication (return QR to caller)
    // - 'ready' means client is authenticated and operational
    // Either way, the caller can proceed (either show QR or fetch catalog).
    // Timeout: 120s — if neither fires, something is wrong (network issue etc.)
    state.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Client initialization timed out after 120s for instance=${instanceName}`));
      }, 120000);

      client.once('qr', () => {
        clearTimeout(timeout);
        // Don't resolve immediately — wait a tick to ensure state.qrCode is set
        // in the 'qr' event handler above before resolving.
        setTimeout(() => resolve(), 100);
      });
      client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      client.once('auth_failure', (msg: string) => {
        clearTimeout(timeout);
        reject(new Error(`Auth failure: ${msg}`));
      });
    });

    // Initialize (async, but don't await — readyPromise will resolve when ready)
    client.initialize().catch((err: Error) => {
      this.logger.error(`[browser] Initialize failed for instance=${instanceName}: ${err.message}`);
    });

    return state;
  }

  /**
   * Public entry: fetch catalog via browser.
   * If session is not authenticated, returns qrCode in the result for the
   * caller to surface to the user.
   */
  async fetchCatalog(options: BrowserCatalogOptions): Promise<BrowserCatalogResult> {
    if (!this.config.enabled) {
      throw new BadRequestException('Browser catalog service is disabled. Set CATALOG_BROWSER_ENABLED=true to enable.');
    }

    const { instanceName } = options;
    this.logger.log(`[browser] fetchCatalog instance=${instanceName}`);

    let state: InstanceClientState;
    try {
      state = await this.getReadyClient(instanceName);
    } catch (err) {
      // If init failed (e.g. not authenticated within timeout),
      // return current QR/pairing state if available
      const currentState = this.clients.get(instanceName);
      if (currentState?.qrCode) {
        return this.buildAuthPendingResult(options.jid, currentState);
      }
      throw err;
    }

    if (!state.ready || state.qrCode) {
      return this.buildAuthPendingResult(options.jid, state);
    }

    // Client is ready — fetch catalog via window.WPP API
    const page = await state.client.pupPage;
    if (!page) {
      throw new BadRequestException('WhatsApp Web page not available');
    }

    // Ensure wa-js is injected before fetching catalog.
    // (injectWaJs is idempotent — skips if WPP already loaded.
    // This fixes a race condition where readyPromise resolves before
    // the 'ready' event handler's injectWaJs call completes.)
    await this.injectWaJs(page);

    // Get the authenticated user's WhatsApp ID (needed for catalog API calls)
    const wppUserId = await page.evaluate(() => {
      const wpp = (window as any).WPP;
      const myUser = wpp?.conn?.getMyUserId ? wpp.conn.getMyUserId() : null;
      return myUser ? myUser._serialized : null;
    });
    if (!wppUserId) {
      throw new BadRequestException('Could not determine WhatsApp user ID');
    }

    const result = await page.evaluate(async (userId: string): Promise<any> => {
      const wpp = (window as any).WPP;
      if (!wpp) return { catalog: [], message: 'WPP not available' };

      const whatsappApi = wpp.whatsapp;
      const productsById = new Map<string, any>();

      const extractProductsFromCatalog = (catalogEntry: any): any[] => {
        if (!catalogEntry) return [];
        const productIndex = catalogEntry.productCollection?._index;
        if (!productIndex || typeof productIndex !== 'object') return [];
        return Object.keys(productIndex)
          .map((productId) => productIndex[productId]?.attributes)
          .filter(Boolean);
      };

      // Catalog fetch strategy:
      // queryCatalog errors with CatalogUnknownError for own catalog (only works
      // for other businesses' catalogs). Use these methods in order:
      //
      // 1. CatalogStore.findQuery — direct store access (most reliable)
      // 2. WPP.catalog.getMyCatalog — wrapper around catalog store
      // 3. WPP.catalog.getProducts(uid, 20) — note: count=20 returns 20,
      //    but count=999 returns only 10 (WhatsApp quirk). Use 20.
      //    Then try count=10 for any additional products not in first batch.
      //
      // All products are serialized immediately via JSON.stringify to avoid
      // Puppeteer serialization crashes with non-serializable prototypes.

      // Catalog fetch with pagination:
      //
      // WhatsApp Web uses lazy-loading (cache). CatalogStore only has the first
      // page (~20 products). To get ALL products, must call findNextProductPage()
      // in a loop — like scrolling down in the UI. Each call fetches the next
      // batch from the server and appends to the store.
      //
      // Flow:
      // 1. CatalogStore.findQuery(uid) → get catalog model + first page
      // 2. Loop: CatalogStore.findNextProductPage(catalog.id) → load next page
      // 3. Extract all products from catalog.productCollection._index
      // 4. Repeat until findNextProductPage returns 0 new products

      const serializeProduct = (p: any): any | null => {
        if (!p?.id) return null;
        try {
          return JSON.parse(JSON.stringify(p, (_k: string, v: any) => (typeof v === 'function' ? undefined : v)));
        } catch {
          return { id: p.id, name: p.name, priceAmount1000: p.priceAmount1000, currency: p.currency };
        }
      };

      // Step 1: Get catalog model from CatalogStore
      if (whatsappApi?.CatalogStore?.findQuery) {
        try {
          const results: any[] = await whatsappApi.CatalogStore.findQuery(userId);
          if (Array.isArray(results) && results.length > 0) {
            const catalogModel = results[0];

            // Extract initial products
            const extractAndAdd = () => {
              const products = extractProductsFromCatalog(catalogModel);
              for (const product of products) {
                const plain = serializeProduct(product);
                if (plain && !productsById.has(plain.id)) {
                  productsById.set(plain.id, plain);
                }
              }
            };
            extractAndAdd();

            // Step 2: Paginate — call findNextProductPage in a loop
            if (whatsappApi.CatalogStore.findNextProductPage) {
              let pageCount = 0;
              const maxPages = 100; // Safety limit
              while (pageCount < maxPages) {
                const beforeCount = productsById.size;
                try {
                  // findNextProductPage(catalogWid) fetches next batch from server
                  // and appends to catalogModel.productCollection._index
                  await whatsappApi.CatalogStore.findNextProductPage(catalogModel.id);
                } catch (e: any) {
                  console.log(`findNextProductPage error (page ${pageCount}):`, e?.message);
                  break;
                }
                // Re-extract products after loading more
                extractAndAdd();
                const afterCount = productsById.size;
                pageCount++;

                console.log(`Page ${pageCount}: ${afterCount - beforeCount} new products (total: ${afterCount})`);

                // If no new products, we've reached the end
                if (afterCount === beforeCount) {
                  break;
                }

                // Small delay between pages (mimic scroll behavior)
                await new Promise((r) => setTimeout(r, 500));
              }
            }
          }
        } catch (error: any) {
          console.log('CatalogStore.findQuery error:', error?.message);
        }
      }

      // Fallback: WPP.catalog.getMyCatalog
      if (productsById.size === 0) {
        try {
          const myCatalog: any = await wpp.catalog?.getMyCatalog?.();
          const fallbackProducts = extractProductsFromCatalog(myCatalog);
          for (const product of fallbackProducts) {
            const plain = serializeProduct(product);
            if (plain && !productsById.has(plain.id)) {
              productsById.set(plain.id, plain);
            }
          }
        } catch (error: any) {
          console.log('getMyCatalog error:', error?.message);
        }
      }

      // Fallback: WPP.catalog.getProducts (max 20 per call)
      if (productsById.size === 0) {
        try {
          const products: any[] = await wpp.catalog?.getProducts?.(userId, 20);
          if (Array.isArray(products)) {
            for (const product of products) {
              const plain = serializeProduct(product);
              if (plain && !productsById.has(plain.id)) {
                productsById.set(plain.id, plain);
              }
            }
          }
        } catch (error: any) {
          console.log('getProducts error:', error?.message);
        }
      }

      // Products are already serialized (plain objects) — return directly
      const catalog = Array.from(productsById.values());

      // Add computed 'price' field from priceAmount1000 (WhatsApp stores
      // prices in 1/1000 units: 3000000 = Rp 3.000)
      for (const p of catalog) {
        if (p.priceAmount1000 != null && p.price === undefined) {
          p.price = String(Math.floor(p.priceAmount1000 / 1000));
        }
      }

      return { catalog };
    }, wppUserId);

    // Null check — page.evaluate can return undefined if the page closes
    // or the evaluation times out
    if (!result || !result.catalog) {
      this.logger.warn(`[browser] fetchCatalog: page.evaluate returned no result`);
      throw new BadRequestException(
        'Catalog fetch failed: WhatsApp Web page returned no data. ' + 'Try again in a few seconds.',
      );
    }

    this.logger.log(`[browser] fetchCatalog got ${result.catalog.length} products`);

    return {
      wuid: options.jid,
      numberExists: true,
      isBusiness: true,
      catalogLength: result.catalog.length,
      catalog: result.catalog,
      truncated: false,
      nextCursor: null,
      source: 'browser',
    };
  }

  /**
   * Public entry: fetch collections via browser.
   */
  async fetchCollections(options: BrowserCollectionsOptions): Promise<BrowserCollectionsResult> {
    if (!this.config.enabled) {
      throw new BadRequestException('Browser catalog service is disabled. Set CATALOG_BROWSER_ENABLED=true to enable.');
    }

    const { instanceName } = options;
    this.logger.log(`[browser] fetchCollections instance=${instanceName}`);

    let state: InstanceClientState;
    try {
      state = await this.getReadyClient(instanceName);
    } catch (err) {
      const currentState = this.clients.get(instanceName);
      if (currentState?.qrCode) {
        return this.buildAuthPendingCollectionsResult(options.jid, currentState);
      }
      throw err;
    }

    if (!state.ready || state.qrCode) {
      return this.buildAuthPendingCollectionsResult(options.jid, state);
    }

    const page = await state.client.pupPage;
    if (!page) {
      throw new BadRequestException('WhatsApp Web page not available');
    }

    await this.injectWaJs(page);

    const wppUserId = await page.evaluate(() => {
      const wpp = (window as any).WPP;
      const myUser = wpp?.conn?.getMyUserId ? wpp.conn.getMyUserId() : null;
      return myUser ? myUser._serialized : null;
    });
    if (!wppUserId) {
      throw new BadRequestException('Could not determine WhatsApp user ID');
    }

    // Get collections metadata only (no product loading — too slow in page.evaluate)
    // Products are fetched separately via getCatalog(browser) and mapped in n8n
    // via keyword matching (auto-categorize).
    const result = await page.evaluate(async (userId: string): Promise<any> => {
      const wpp = (window as any).WPP;
      if (!wpp) return { collections: [] };

      const collections: any[] = [];

      try {
        const cols = await wpp.catalog.getCollections(userId, 100, 50);
        if (Array.isArray(cols)) {
          for (const c of cols) {
            const a = c?.attributes || c;
            if (!a?.id) continue;
            collections.push({
              id: a.id,
              name: a.name || '',
              products: [],
              status: a.reviewStatus || a.status,
              totalItemsCount: a.totalItemsCount || 0,
            });
          }
        }
      } catch (error: any) {
        console.log('getCollections error:', error?.message);
      }

      return { collections };
    }, wppUserId);

    this.logger.log(`[browser] fetchCollections: ${result.collections.length} collections`);

    return {
      wuid: options.jid,
      name: null,
      numberExists: true,
      isBusiness: true,
      collectionsLength: result.collections.length,
      collections: result.collections,
      source: 'browser',
    };
  }

  /**
   * Browser fallback: fetch products per collection via wa-js webpack modules.
   *
   * This is called when Baileys' protocol-level getCollections returns 0
   * products (e.g. anti-bot blocked, or instance not fully business-verified).
   *
   * Strategy (tries multiple methods in order):
   *   1. WPP.whatsapp.ProductCollCollection.findCollectionProducts(collectionId, limit)
   *      — same method web.whatsapp.com's UI uses when you click a collection
   *   2. WPP.whatsapp.CatalogCollection.findCollectionMembership(catalogWid, productId)
   *      — alternative: check membership for each known product (slower)
   *   3. Iterate CatalogStore.productCollection._index and filter by collectionId
   *      — last resort: scan all cached products (works only if catalog was
   *        already fetched via getCatalog before this call)
   *
   * Returns one entry per input collection (even if 0 products or error).
   */
  async fetchCollectionProductsFallback(options: {
    instanceName: string;
    collectionIds: Array<{ id: string; name?: string }>;
    productsPerCollection: number;
  }): Promise<{
    productsByCollectionId: Array<{
      collectionId: string;
      collectionName?: string;
      products: any[];
      method: string;
      error?: string;
      attempts?: any[];
    }>;
    diagnostic?: any;
  }> {
    if (!this.config.enabled) {
      throw new BadRequestException('Browser catalog service is disabled. Set CATALOG_BROWSER_ENABLED=true to enable.');
    }

    const { instanceName, collectionIds, productsPerCollection } = options;
    this.logger.log(
      `[browser-fallback] Fetching products for ${collectionIds.length} collections ` +
        `(productsPerCollection=${productsPerCollection})`,
    );

    let state: InstanceClientState;
    try {
      state = await this.getReadyClient(instanceName);
    } catch (err) {
      throw new BadRequestException(`Browser client not ready: ${(err as Error)?.message}`);
    }

    if (!state.ready || state.qrCode) {
      throw new BadRequestException('Browser session not authenticated. Scan QR code first.');
    }

    const page = await state.client.pupPage;
    if (!page) {
      throw new BadRequestException('WhatsApp Web page not available');
    }

    await this.injectWaJs(page);

    const wppUserId = await page.evaluate(() => {
      const wpp = (window as any).WPP;
      const myUser = wpp?.conn?.getMyUserId ? wpp.conn.getMyUserId() : null;
      return myUser ? myUser._serialized : null;
    });
    if (!wppUserId) {
      throw new BadRequestException('Could not determine WhatsApp user ID');
    }

    // Execute fallback strategy in page context.
    // We pass the list of collection IDs and let the page code try each method.
    const result = await page.evaluate(
      async (userId: string, collections: Array<{ id: string; name?: string }>, limit: number): Promise<any> => {
        const wpp = (window as any).WPP;
        if (!wpp) return { results: [], error: 'WPP not available' };

        const wa = wpp.whatsapp;
        if (!wa) return { results: [], error: 'WPP.whatsapp not available' };

        // === Diagnostic: record what's actually available on WPP.whatsapp ===
        const diag: any = {
          waKeys: Object.keys(wa)
            .filter((k) => /catalog|collection|product|wid/i.test(k))
            .slice(0, 30),
          hasWidFactory: !!wa.WidFactory,
          hasCreateWid: typeof wa.WidFactory?.createWid === 'function',
          hasCreateWidFromWidLike: typeof wa.WidFactory?.createWidFromWidLike === 'function',
          hasProductCollCollection: !!wa.ProductCollCollection,
          productCollCollectionMethods: wa.ProductCollCollection
            ? Object.getOwnPropertyNames(wa.ProductCollCollection).concat(
                Object.getOwnPropertyNames(Object.getPrototypeOf(wa.ProductCollCollection) || {}),
              )
            : [],
          hasCatalogCollection: !!wa.CatalogCollection,
          hasCatalogStore: !!wa.CatalogStore,
          catalogStoreMethods: wa.CatalogStore
            ? Object.getOwnPropertyNames(wa.CatalogStore).concat(
                Object.getOwnPropertyNames(Object.getPrototypeOf(wa.CatalogStore) || {}),
              )
            : [],
          hasCatalog: !!wpp.catalog,
          catalogMethods: wpp.catalog ? Object.keys(wpp.catalog) : [],
        };

        // Helper: create a Wid object from any string (user JID or collection ID)
        // Uses WidFactory if available (correct API); falls back to plain object
        const makeWid = (id: string): any => {
          try {
            if (wa.WidFactory?.createWid) return wa.WidFactory.createWid(id);
            if (wa.WidFactory?.createWidFromWidLike) return wa.WidFactory.createWidFromWidLike(id);
          } catch (e: any) {
            console.log(`makeWid(${id}) failed:`, e?.message);
          }
          return { _serialized: id, id, toString: () => id };
        };

        // Helper: serialize WhatsApp model to plain object
        const serializeProduct = (p: any): any | null => {
          if (!p) return null;
          // Models have .attributes; raw objects are themselves
          const attrs = p?.attributes || p;
          if (!attrs?.id) return null;
          try {
            return JSON.parse(JSON.stringify(attrs, (_k: string, v: any) => (typeof v === 'function' ? undefined : v)));
          } catch {
            return {
              id: attrs.id,
              name: attrs.name,
              priceAmount1000: attrs.priceAmount1000,
              currency: attrs.currency,
            };
          }
        };

        // Track all method attempts for diagnostics
        const attempts: any[] = [];

        // Helper: try multiple methods to get products for a collection
        const getProductsForCollection = async (
          collectionId: string,
          productLimit: number,
        ): Promise<{ products: any[]; method: string; error?: string; attempts: any[] }> => {
          // Method 1: ProductCollCollection.findCollectionProducts(collectionWid, limit)
          //   - Same method web.whatsapp.com UI uses when clicking a collection
          //   - Returns ProductModel[] for that collection
          try {
            if (wa.ProductCollCollection?.findCollectionProducts) {
              const wid = makeWid(collectionId);
              attempts.push({ method: 'ProductCollCollection.findCollectionProducts', wid: String(wid) });
              const products: any[] = await wa.ProductCollCollection.findCollectionProducts(wid, productLimit);
              attempts[attempts.length - 1].result = Array.isArray(products)
                ? `${products.length} products`
                : `non-array: ${typeof products}`;
              if (Array.isArray(products) && products.length > 0) {
                return {
                  products: products.map(serializeProduct).filter(Boolean),
                  method: 'ProductCollCollection.findCollectionProducts',
                  attempts,
                };
              }
            } else {
              attempts.push({
                method: 'ProductCollCollection.findCollectionProducts',
                skipped: 'method not available',
              });
            }
          } catch (e: any) {
            attempts.push({ method: 'ProductCollCollection.findCollectionProducts', error: e?.message });
          }

          // Method 2: CatalogCollection.findCollectionMembership(catalogWid, productId, collectionWid?)
          //   - Iterate ALL catalog products and check membership one-by-one
          //   - Slow but works if catalog is already loaded in store
          try {
            if (wa.CatalogCollection?.findCollectionMembership) {
              const catalogWid = makeWid(userId);
              const catalogModels = wa.CatalogStore?.findQuery ? await wa.CatalogStore.findQuery(catalogWid) : null;
              attempts.push({
                method: 'CatalogCollection.findCollectionMembership',
                catalogModels: Array.isArray(catalogModels) ? catalogModels.length : 'n/a',
              });
              if (Array.isArray(catalogModels) && catalogModels.length > 0) {
                const catalogModel = catalogModels[0];
                const allProducts = catalogModel?.productCollection?._index
                  ? Object.values(catalogModel.productCollection._index)
                  : [];
                attempts[attempts.length - 1].totalCatalogProducts = allProducts.length;
                const memberProducts: any[] = [];
                for (const p of allProducts) {
                  if (memberProducts.length >= productLimit) break;
                  try {
                    const productModel = (p as any)?.attributes || p;
                    const productId = productModel?.id;
                    if (!productId) continue;
                    // findCollectionMembership may take (collectionWid, productId)
                    // or (catalogWid, productId, collectionWid) — try both signatures
                    const collectionWid = makeWid(collectionId);
                    let isMember: any;
                    try {
                      isMember = await wa.CatalogCollection.findCollectionMembership(collectionWid, productId);
                    } catch {
                      isMember = await wa.CatalogCollection.findCollectionMembership(
                        catalogWid,
                        productId,
                        collectionWid,
                      );
                    }
                    if (isMember) {
                      const plain = serializeProduct(productModel);
                      if (plain) memberProducts.push(plain);
                    }
                  } catch {
                    // skip individual product errors
                  }
                }
                attempts[attempts.length - 1].matchedProducts = memberProducts.length;
                if (memberProducts.length > 0) {
                  return {
                    products: memberProducts,
                    method: 'CatalogCollection.findCollectionMembership',
                    attempts,
                  };
                }
              }
            } else {
              attempts.push({ method: 'CatalogCollection.findCollectionMembership', skipped: 'method not available' });
            }
          } catch (e: any) {
            attempts.push({ method: 'CatalogCollection.findCollectionMembership', error: e?.message });
          }

          // Method 3: Scan CatalogStore.products for collection-related fields
          //   - Some WhatsApp versions store collectionId on ProductModel attributes
          try {
            const catalogWid = makeWid(userId);
            const catalogModels = wa.CatalogStore?.findQuery ? await wa.CatalogStore.findQuery(catalogWid) : null;
            attempts.push({
              method: 'CatalogStore.scanByCollectionId',
              catalogModels: Array.isArray(catalogModels) ? catalogModels.length : 'n/a',
            });
            if (Array.isArray(catalogModels) && catalogModels.length > 0) {
              const catalogModel = catalogModels[0];
              const allProducts = catalogModel?.productCollection?._index
                ? Object.values(catalogModel.productCollection._index)
                : [];
              attempts[attempts.length - 1].totalCatalogProducts = allProducts.length;
              // Sample product to see what fields exist
              if (allProducts.length > 0) {
                const sample = (allProducts[0] as any)?.attributes || allProducts[0];
                attempts[attempts.length - 1].sampleProductKeys = Object.keys(sample).slice(0, 30);
              }
              const matching = allProducts
                .map((p: any) => p?.attributes || p)
                .filter((p: any) => {
                  // Check various possible field names
                  return (
                    p?.collectionId === collectionId ||
                    p?.collection_id === collectionId ||
                    (Array.isArray(p?.collectionIds) && p.collectionIds.includes(collectionId)) ||
                    (Array.isArray(p?.collection_ids) && p.collection_ids.includes(collectionId)) ||
                    p?.collectionWid?._serialized === collectionId ||
                    p?.collectionWid === collectionId
                  );
                })
                .map(serializeProduct)
                .filter(Boolean)
                .slice(0, productLimit);
              attempts[attempts.length - 1].matchedProducts = matching.length;
              if (matching.length > 0) {
                return {
                  products: matching,
                  method: 'CatalogStore.scanByCollectionId',
                  attempts,
                };
              }
            }
          } catch (e: any) {
            attempts.push({ method: 'CatalogStore.scanByCollectionId', error: e?.message });
          }

          return { products: [], method: 'none', error: 'All methods returned 0 products', attempts };
        };

        // Process each collection (sequentially to avoid rate limiting)
        const results: any[] = [];
        for (const col of collections) {
          const r = await getProductsForCollection(col.id, limit);
          results.push({
            collectionId: col.id,
            collectionName: col.name,
            products: r.products,
            method: r.method,
            error: r.error,
            attempts: r.attempts,
          });
          // Small delay between collections
          await new Promise((res) => setTimeout(res, 300));
        }

        return { results, diag };
      },
      wppUserId,
      collectionIds,
      productsPerCollection,
    );

    this.logger.log(
      `[browser-fallback] Done. ${result?.results?.filter((r: any) => r.products?.length > 0).length || 0} ` +
        `collections have products, total: ${result?.results?.reduce((s: number, r: any) => s + (r.products?.length || 0), 0) || 0}`,
    );
    if (result?.diag) {
      this.logger.log(`[browser-fallback] Diagnostic: ${JSON.stringify(result.diag).slice(0, 500)}`);
    }

    return {
      productsByCollectionId: result?.results || [],
      diagnostic: result?.diag,
    };
  }

  async requestPairingCode(instanceName: string, phoneNumber: string): Promise<string> {
    if (!this.config.enabled) {
      throw new BadRequestException('Browser catalog service is disabled. Set CATALOG_BROWSER_ENABLED=true to enable.');
    }

    // Validate phone format: international, digits only (no +, no spaces)
    if (!phoneNumber || !/^\d{6,15}$/.test(phoneNumber)) {
      throw new BadRequestException(
        'Invalid phone number. Must be international format, digits only (e.g. "6285733556953" for Indonesia). ' +
          'No "+", spaces, or hyphens.',
      );
    }

    const state = await this.getReadyClient(instanceName);

    // If already authenticated, no need for pairing code
    if (state.ready) {
      throw new BadRequestException(
        `Instance "${instanceName}" browser session is already authenticated. No pairing code needed.`,
      );
    }

    // requestPairingCode requires the client to be in UNPAIRED state (socket connected
    // but not yet authenticated). The 'qr' event guarantees this state.
    // getReadyClient resolves on 'qr' or 'ready', so we should be safe here.
    const code = await state.client.requestPairingCode(phoneNumber);
    state.pairingCode = code;
    this.logger.log(`[browser] Pairing code requested for instance=${instanceName} phone=${phoneNumber}: ${code}`);
    return code;
  }

  /**
   * Get current auth state for an instance (qrCode, pairingCode, ready).
   */
  getAuthState(instanceName: string): {
    ready: boolean;
    qrCode: string | null;
    pairingCode: string | null;
    userId: string | null;
  } {
    const state = this.clients.get(instanceName);
    if (!state) {
      return { ready: false, qrCode: null, pairingCode: null, userId: null };
    }
    // Extract userId from client.info if available (set after 'ready' event)
    let userId: string | null = null;
    try {
      if (state.ready && state.client?.info?.wid) {
        userId = state.client.info.wid._serialized || null;
      }
    } catch {
      // client.info may not be available yet
    }
    return {
      ready: state.ready,
      qrCode: state.qrCode,
      pairingCode: state.pairingCode,
      userId,
    };
  }

  /**
   * Logout: kill client + delete session for an instance.
   */
  async logout(instanceName: string): Promise<void> {
    await this.killClient(instanceName);
    const userDataDir = this.userDataDir(instanceName);
    if (existsSync(userDataDir)) {
      rmSync(userDataDir, { recursive: true, force: true });
      this.logger.log(`[browser] Deleted session for instance=${instanceName}`);
    }
  }

  /**
   * Shutdown all clients (for graceful app close).
   */
  async shutdownAll(): Promise<void> {
    const names = Array.from(this.clients.keys());
    await Promise.all(names.map((n) => this.killClient(n)));
    this.logger.log(`[browser] Shutdown ${names.length} client(s)`);
  }

  private buildAuthPendingResult(jid: string, state: InstanceClientState): BrowserCatalogResult {
    const result: any = {
      wuid: jid,
      numberExists: true,
      isBusiness: true,
      catalogLength: 0,
      catalog: [],
      truncated: false,
      nextCursor: null,
      source: 'browser',
      status: 'auth_required',
    };
    if (state.qrCode) result.qrCode = state.qrCode;
    if (state.pairingCode) result.pairingCode = state.pairingCode;
    return result;
  }

  private buildAuthPendingCollectionsResult(jid: string, state: InstanceClientState): BrowserCollectionsResult {
    const result: any = {
      wuid: jid,
      name: null,
      numberExists: true,
      isBusiness: true,
      collectionsLength: 0,
      collections: [],
      source: 'browser',
      status: 'auth_required',
    };
    if (state.qrCode) result.qrCode = state.qrCode;
    if (state.pairingCode) result.pairingCode = state.pairingCode;
    return result;
  }

  /**
   * Reset the idle timer for an instance. When timer fires, the client
   * is killed to free memory.
   */
  private resetIdleTimer(instanceName: string): void {
    const state = this.clients.get(instanceName);
    if (!state) return;

    if (state.idleTimer) clearTimeout(state.idleTimer);

    state.idleTimer = setTimeout(() => {
      this.logger.log(`[browser] Idle timeout for instance=${instanceName}, killing client`);
      this.killClient(instanceName).catch((err) => {
        this.logger.error(`[browser] Failed to kill idle client: ${(err as Error).message}`);
      });
    }, this.config.idleTimeoutMs);
  }

  /**
   * Kill the client for an instance and clean up timers.
   */
  private async killClient(instanceName: string): Promise<void> {
    const state = this.clients.get(instanceName);
    if (!state) return;

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    try {
      await state.client.destroy();
    } catch (err) {
      this.logger.warn(`[browser] Error closing client: ${(err as Error).message}`);
    }

    this.clients.delete(instanceName);
  }
}
