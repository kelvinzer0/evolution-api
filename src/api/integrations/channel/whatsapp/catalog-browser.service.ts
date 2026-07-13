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

    // === Pure wa-js collection fetch with product mapping ===
    //
    // Architecture (mirrors getCatalog's store-based approach):
    //   1. WPP.catalog.getCollections(userId, limit, productsCount) → metadata
    //      This sends IQ stanza via queryCollectionsIQ and populates:
    //        - CatalogStore with collection metadata
    //        - CatalogModel.collections with ProductCollCollection instance
    //   2. CatalogStore.findQuery(userId) → CatalogModel
    //   3. catalogModel.collections → ProductCollCollection instance
    //   4. For each collection:
    //      a. collections.findCollectionProducts(collectionId, limit) → products
    //      b. Fallback: CatalogStore.findCollectionMembership(productId) per product
    //      c. Fallback: scan catalogModel.productCollection._index for collectionId field
    //
    // This is the same pattern that made getCatalog work (findNextProductPage
    // loop on CatalogStore). Now applied to collections.
    const limit = options.limit || 100;

    // Set a longer timeout for page.evaluate — default is 30s which is too
    // short for catalog operations. We need up to 3 minutes for slow connections.
    try {
      await page.setDefaultTimeout(180000);
    } catch {
      // setDefaultTimeout may not exist in all puppeteer versions — ignore
    }

    const result = await page
      .evaluate(
        async (userId: string, colLimit: number): Promise<any> => {
          const wpp = (window as any).WPP;
          if (!wpp) return { collections: [], error: 'WPP not available' };

          const wa = wpp.whatsapp;
          if (!wa) return { collections: [], error: 'WPP.whatsapp not available' };

          // Helper: create Wid from string
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
            const attrs = p?.attributes || p;
            if (!attrs?.id) return null;
            try {
              return JSON.parse(
                JSON.stringify(attrs, (_k: string, v: any) => (typeof v === 'function' ? undefined : v)),
              );
            } catch {
              return {
                id: attrs.id,
                name: attrs.name,
                priceAmount1000: attrs.priceAmount1000,
                currency: attrs.currency,
              };
            }
          };

          // Diagnostic info
          const diag: any = {
            catalogStoreExists: !!wa.CatalogStore,
            catalogStoreMethods: wa.CatalogStore
              ? Object.getOwnPropertyNames(Object.getPrototypeOf(wa.CatalogStore) || {})
                  .concat(Object.getOwnPropertyNames(wa.CatalogStore))
                  .filter((m: string) => typeof wa.CatalogStore[m] === 'function' && !m.startsWith('_'))
              : [],
            productCollCollectionExists: !!wa.ProductCollCollection,
          };

          // Step 1: Get collection metadata via WPP.catalog.getCollections
          // This also populates CatalogStore and CatalogModel.collections
          const collections: any[] = [];
          try {
            // productsCount=colLimit — request up to colLimit products per collection
            const cols = await wpp.catalog.getCollections(userId, colLimit, colLimit);
            if (Array.isArray(cols)) {
              for (const c of cols) {
                const a = c?.attributes || c;
                if (!a?.id) continue;
                collections.push({
                  id: String(a.id),
                  name: a.name || '',
                  products: [],
                  status: a.reviewStatus || a.status,
                  totalItemsCount: a.totalItemsCount || 0,
                });
              }
            }
            diag.getCollectionsCount = collections.length;
          } catch (error: any) {
            diag.getCollectionsError = error?.message;
            console.log('getCollections error:', error?.message);
          }

          if (collections.length === 0) {
            return { collections: [], diag, error: 'No collections returned by getCollections' };
          }

          // Step 2: Get CatalogModel via CatalogStore.findQuery
          // This gives us access to catalogModel.collections (ProductCollCollection instance)
          let catalogModel: any = null;
          let productCollCollection: any = null;
          try {
            const userWid = makeWid(userId);
            const catalogModels = wa.CatalogStore?.findQuery ? await wa.CatalogStore.findQuery(userWid) : null;
            if (Array.isArray(catalogModels) && catalogModels.length > 0) {
              catalogModel = catalogModels[0];
              diag.catalogModelKeys = Object.keys(catalogModel.attributes || catalogModel).slice(0, 30);
              diag.catalogModelHasProductCollection = !!catalogModel.productCollection;
              diag.catalogModelHasCollections = !!catalogModel.collections;
              diag.catalogModelCollectionsType = typeof catalogModel.collections;
              diag.catalogModelCollectionsIsArray = Array.isArray(catalogModel.collections);

              // Step 3: Access catalogModel.collections → ProductCollCollection instance
              if (catalogModel.collections) {
                productCollCollection = catalogModel.collections;
                const pccProto = Object.getPrototypeOf(productCollCollection) || {};
                diag.productCollCollectionMethods = Object.getOwnPropertyNames(pccProto)
                  .concat(Object.getOwnPropertyNames(productCollCollection))
                  .filter((m: string) => typeof productCollCollection[m] === 'function' && !m.startsWith('_'));
                diag.productCollCollectionHas = {
                  findCollectionProducts: typeof productCollCollection.findCollectionProducts === 'function',
                  getCollectionModels: typeof productCollCollection.getCollectionModels === 'function',
                  findCollectionsList: typeof productCollCollection.findCollectionsList === 'function',
                };
                // Also check if it's an array-like with length
                diag.productCollCollectionLength = productCollCollection.length;
              }
            }
          } catch (error: any) {
            diag.catalogModelError = error?.message;
            console.log('CatalogStore.findQuery error:', error?.message);
          }

          // Step 4: For each collection, try to get products
          // Build a map: collectionId → products[]
          const productsByCollectionId = new Map<string, any[]>();
          const perCollectionDebug: any[] = [];

          // === Pre-step: Populate ProductCollCollection store ===
          // Diagnostic showed productCollCollectionLength: 0 — store is EMPTY.
          // getCollections only returns metadata, doesn't populate products.
          // We need to call findCollectionsList to fetch collection products.
          if (productCollCollection?.findCollectionsList) {
            try {
              const userWid = makeWid(userId);
              diag.findCollectionsListCalled = true;
              await productCollCollection.findCollectionsList(userWid, limit, limit);
              diag.productCollCollectionLengthAfter = productCollCollection.length;
              // Re-check methods availability
              diag.productCollCollectionHasAfter = {
                findCollectionProducts: typeof productCollCollection.findCollectionProducts === 'function',
                getCollectionModels: typeof productCollCollection.getCollectionModels === 'function',
                findCollectionsList: typeof productCollCollection.findCollectionsList === 'function',
              };
            } catch (e: any) {
              diag.findCollectionsListError = e?.message;
            }
          }

          // === Pre-step: Check catalogModel._products field ===
          let catalogModelProducts: any = null;
          if (catalogModel?._products) {
            catalogModelProducts = catalogModel._products;
            diag.catalogModelProductsType = typeof catalogModelProducts;
            diag.catalogModelProductsIsArray = Array.isArray(catalogModelProducts);
            diag.catalogModelProductsKeys = Object.keys(catalogModelProducts).slice(0, 20);
            diag.catalogModelProductsLength = catalogModelProducts.length;
            if (catalogModelProducts instanceof Map) {
              diag.catalogModelProductsIsMap = true;
              diag.catalogModelProductsMapSize = catalogModelProducts.size;
              diag.catalogModelProductsMapKeys = Array.from(catalogModelProducts.keys()).slice(0, 10);
            }
          }

          for (const col of collections) {
            const colId = col.id;
            const colName = col.name;
            let products: any[] = [];
            let method = 'none';
            const attempts: any[] = [];

            // Method A: findCollectionMembership(collectionWid) — SINGLE arg
            //   - Might return all products that are members of this collection
            //   - Only 1 async call per collection (9 total) — fast
            if (wa.CatalogStore?.findCollectionMembership) {
              try {
                const colWid = makeWid(colId);
                attempts.push({ method: 'findCollectionMembership(single)', collectionId: colId });
                const result: any = await wa.CatalogStore.findCollectionMembership(colWid);
                attempts[attempts.length - 1].result = Array.isArray(result)
                  ? `${result.length} items`
                  : `type: ${typeof result}`;
                if (Array.isArray(result) && result.length > 0) {
                  products = result.map(serializeProduct).filter(Boolean);
                  method = 'CatalogStore.findCollectionMembership(single)';
                }
              } catch (e: any) {
                attempts.push({ method: 'findCollectionMembership(single)', error: e?.message });
              }
            }

            // Method A2: findCollectionMembership(catalogWid, collectionWid) — TWO args
            if (products.length === 0 && wa.CatalogStore?.findCollectionMembership) {
              try {
                const userWid = makeWid(userId);
                const colWid = makeWid(colId);
                attempts.push({ method: 'findCollectionMembership(two)', collectionId: colId });
                const result: any = await wa.CatalogStore.findCollectionMembership(userWid, colWid);
                attempts[attempts.length - 1].result = Array.isArray(result)
                  ? `${result.length} items`
                  : `type: ${typeof result}`;
                if (Array.isArray(result) && result.length > 0) {
                  products = result.map(serializeProduct).filter(Boolean);
                  method = 'CatalogStore.findCollectionMembership(two)';
                }
              } catch (e: any) {
                attempts.push({ method: 'findCollectionMembership(two)', error: e?.message });
              }
            }

            // Method A3: getCollectionModels with Wid (not string)
            if (products.length === 0 && productCollCollection?.getCollectionModels) {
              try {
                const colWid = makeWid(colId);
                attempts.push({ method: 'getCollectionModels(wid)', collectionId: colId });
                const result: any = await productCollCollection.getCollectionModels(colWid, colLimit);
                attempts[attempts.length - 1].result = Array.isArray(result)
                  ? `${result.length} items`
                  : `type: ${typeof result}`;
                if (Array.isArray(result) && result.length > 0) {
                  products = result.map(serializeProduct).filter(Boolean);
                  method = 'ProductCollCollection.getCollectionModels(wid)';
                }
              } catch (e: any) {
                attempts.push({ method: 'getCollectionModels(wid)', error: e?.message });
              }
            }

            // Method B: Access catalogModel._products directly
            //   - If _products is a Map<collectionId, ProductModel[]>, get products for this collection
            //   - This is synchronous — no async calls
            if (products.length === 0 && catalogModelProducts) {
              try {
                let colProducts: any = null;
                if (catalogModelProducts instanceof Map) {
                  colProducts = catalogModelProducts.get(colId);
                } else if (typeof catalogModelProducts === 'object') {
                  colProducts = catalogModelProducts[colId];
                }
                attempts.push({
                  method: 'catalogModel._products',
                  hasProducts: !!colProducts,
                  productsType: typeof colProducts,
                  productsIsArray: Array.isArray(colProducts),
                });
                if (Array.isArray(colProducts) && colProducts.length > 0) {
                  products = colProducts.map(serializeProduct).filter(Boolean);
                  method = 'catalogModel._products';
                } else if (colProducts && typeof colProducts === 'object') {
                  // Might be a Collection — try to convert to array
                  const arr = Array.isArray(colProducts)
                    ? colProducts
                    : colProducts._index
                      ? Object.values(colProducts._index)
                      : [];
                  if (arr.length > 0) {
                    products = arr.map(serializeProduct).filter(Boolean);
                    method = 'catalogModel._products(collection)';
                  }
                }
              } catch (e: any) {
                attempts.push({ method: 'catalogModel._products', error: e?.message });
              }
            }

            // Method B2: Check productCollCollection._index AFTER findCollectionsList
            //   - findCollectionsList should have populated the store with collection models
            //   - Each collection model might have products attached
            if (products.length === 0 && productCollCollection?._index) {
              try {
                const idx = productCollCollection._index;
                const idxKeys = Object.keys(idx);
                const idxValues = Object.values(idx);
                attempts.push({
                  method: 'productCollCollection._index',
                  indexSize: idxKeys.length,
                  indexKeys: idxKeys.slice(0, 10),
                });
                // Check if any collection model in the index matches our colId
                for (const cm of idxValues) {
                  const cmAttrs = (cm as any)?.attributes || cm;
                  if (String(cmAttrs?.id) === colId) {
                    // Found the collection model — check if it has products
                    const cmProducts = (cm as any)?.products || cmAttrs?.products;
                    if (Array.isArray(cmProducts) && cmProducts.length > 0) {
                      products = cmProducts.map(serializeProduct).filter(Boolean);
                      method = 'productCollCollection._index';
                      attempts[attempts.length - 1].matchedProducts = products.length;
                      break;
                    }
                  }
                }
              } catch (e: any) {
                attempts.push({ method: 'productCollCollection._index', error: e?.message });
              }
            }

            // Method C: Scan catalogModel.productCollection for collectionId field
            //   - Check if products have collectionId/collectionIds in their attributes
            //   - This is a SINGLE PASS over all products — fast, no async calls
            if (products.length === 0 && catalogModel?.productCollection?._index) {
              try {
                const allProducts = Object.values(catalogModel.productCollection._index);
                // Log sample product keys for diagnostics
                if (allProducts.length > 0) {
                  const sample = (allProducts[0] as any)?.attributes || allProducts[0];
                  attempts.push({
                    method: 'scanByCollectionId',
                    totalProducts: allProducts.length,
                    sampleProductKeys: Object.keys(sample).slice(0, 30),
                  });
                }
                const matching = allProducts
                  .map((p: any) => p?.attributes || p)
                  .filter((p: any) => {
                    return (
                      String(p?.collectionId) === colId ||
                      String(p?.collection_id) === colId ||
                      (Array.isArray(p?.collectionIds) && p.collectionIds.some((c: any) => String(c) === colId)) ||
                      (Array.isArray(p?.collection_ids) && p.collection_ids.some((c: any) => String(c) === colId)) ||
                      String(p?.collectionWid?._serialized) === colId ||
                      String(p?.collectionWid) === colId
                    );
                  })
                  .map(serializeProduct)
                  .filter(Boolean)
                  .slice(0, colLimit);
                if (attempts[attempts.length - 1]) {
                  attempts[attempts.length - 1].matchedProducts = matching.length;
                }
                if (matching.length > 0) {
                  products = matching;
                  method = 'CatalogStore.scanByCollectionId';
                }
              } catch (e: any) {
                attempts.push({ method: 'scanByCollectionId', error: e?.message });
              }
            }

            // Store products for this collection
            productsByCollectionId.set(colId, products);
            perCollectionDebug.push({
              collectionId: colId,
              collectionName: colName,
              productCount: products.length,
              method,
              attempts: attempts.length > 0 ? attempts : undefined,
            });
          }

          // Attach products to collections
          for (const col of collections) {
            const prods = productsByCollectionId.get(col.id) || [];
            col.products = prods;
            col.productsLength = prods.length;
            col.totalItemsCount = prods.length;
          }

          const totalProducts = collections.reduce(
            (sum: number, c: any) => sum + (Array.isArray(c.products) ? c.products.length : 0),
            0,
          );

          return {
            collections,
            diag,
            perCollectionDebug,
            totalProducts,
          };
        },
        wppUserId,
        limit,
      )
      .catch((err: Error) => {
        // Catch "Target closed" / Protocol errors — these happen when the
        // browser page closes mid-evaluate (OOM, WhatsApp Web reload, etc.)
        // Return a partial result with the error so the caller can see what happened.
        this.logger.error(`[browser] fetchCollections page.evaluate failed: ${err?.message}`);
        return {
          collections: [],
          diag: { pageEvaluateError: err?.message },
          perCollectionDebug: [],
          totalProducts: 0,
          error: err?.message,
        };
      });

    this.logger.log(
      `[browser] fetchCollections: ${result.collections.length} collections, ` +
        `${result.totalProducts || 0} products mapped`,
    );
    if (result.diag) {
      this.logger.log(`[browser] Diagnostic: ${JSON.stringify(result.diag).slice(0, 500)}`);
    }

    return {
      wuid: options.jid,
      name: null,
      numberExists: true,
      isBusiness: true,
      collectionsLength: result.collections.length,
      collections: result.collections,
      source: 'browser',
      diagnostic: result.diag,
      perCollectionDebug: result.perCollectionDebug,
      totalProductsMapped: result.totalProducts || 0,
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
