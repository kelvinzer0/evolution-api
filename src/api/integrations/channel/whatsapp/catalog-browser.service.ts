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
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Client, LocalAuth } from 'whatsapp-web.js';

import {
  BrowserCatalogConfig,
  BrowserCatalogOptions,
  BrowserCatalogResult,
  BrowserCollection,
  BrowserCollectionsOptions,
  BrowserCollectionsResult,
  BrowserProduct,
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

    const result = await page.evaluate(
      async (): Promise<{
        catalog: BrowserProduct[];
        message?: string;
      }> => {
        const wpp = (window as any).WPP;
        if (!wpp) return { catalog: [], message: 'WPP not available' };

        const myUser = wpp.conn ? (wpp.conn.getMyUserId ? wpp.conn.getMyUserId() : null) : null;
        const userId = (myUser && myUser._serialized) || '';
        if (!userId) return { catalog: [], message: 'User ID not found' };

        const whatsappApi = wpp.whatsapp;
        const productsById = new Map<string, BrowserProduct>();

        const addProduct = (rawProduct: any) => {
          const product = rawProduct?.attributes || rawProduct;
          if (!product?.id) return;
          if (!productsById.has(product.id)) {
            productsById.set(product.id, product as BrowserProduct);
          }
        };

        const extractProductsFromCatalog = (catalogEntry: any): any[] => {
          if (!catalogEntry) return [];
          const productIndex = catalogEntry.productCollection?._index;
          if (!productIndex || typeof productIndex !== 'object') return [];
          return Object.keys(productIndex)
            .map((productId) => productIndex[productId]?.attributes)
            .filter(Boolean);
        };

        // Layer 1: queryCatalog with pagination cursor
        if (whatsappApi?.functions?.queryCatalog) {
          try {
            let afterToken: string | undefined = undefined;
            let safetyCount = 0;
            while (safetyCount < 500) {
              const response: any = await whatsappApi.functions.queryCatalog(userId, afterToken);
              const pageProducts: any[] = Array.isArray(response?.data) ? response.data : [];
              for (const product of pageProducts) {
                addProduct(product);
              }
              const nextAfter = response?.paging?.cursors?.after;
              if (!nextAfter || nextAfter === afterToken) break;
              afterToken = nextAfter;
              safetyCount++;
            }
          } catch (error: any) {
            console.log('queryCatalog unavailable:', error?.message);
          }
        }

        // Layer 2: CatalogStore.findQuery
        if (whatsappApi?.CatalogStore?.findQuery) {
          try {
            const results: any[] = await whatsappApi.CatalogStore.findQuery(userId);
            if (Array.isArray(results)) {
              for (const entry of results) {
                const products = extractProductsFromCatalog(entry);
                for (const product of products) {
                  addProduct(product);
                }
              }
            }
          } catch (error: any) {
            console.log('CatalogStore.findQuery unavailable:', error?.message);
          }
        }

        // Layer 3: WPP.catalog.getMyCatalog
        try {
          const myCatalog: any = await wpp.catalog?.getMyCatalog?.();
          const fallbackProducts = extractProductsFromCatalog(myCatalog);
          for (const product of fallbackProducts) {
            addProduct(product);
          }
        } catch (error: any) {
          console.log('getMyCatalog unavailable:', error?.message);
        }

        // Layer 4: WPP.catalog.getProducts (last resort)
        if (productsById.size === 0) {
          try {
            const fallbackProducts: any[] = await wpp.catalog?.getProducts?.(userId, 999);
            if (Array.isArray(fallbackProducts)) {
              for (const product of fallbackProducts) {
                addProduct(product);
              }
            }
          } catch (error: any) {
            console.log('getProducts unavailable:', error?.message);
          }
        }

        return { catalog: Array.from(productsById.values()) };
      },
    );

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

    const result = await page.evaluate(
      async (): Promise<{
        collections: BrowserCollection[];
        message?: string;
      }> => {
        const wpp = (window as any).WPP;
        if (!wpp) return { collections: [], message: 'WPP not available' };

        const myUser = wpp.conn ? (wpp.conn.getMyUserId ? wpp.conn.getMyUserId() : null) : null;
        const userId = (myUser && myUser._serialized) || '';
        if (!userId) return { collections: [], message: 'User ID not found' };

        const whatsappApi = wpp.whatsapp;
        const collections: BrowserCollection[] = [];

        // Method 1: WPP.catalog.getCollections
        try {
          const response: any = await wpp.catalog?.getCollections?.(userId);
          if (Array.isArray(response)) {
            for (const c of response) {
              const attrs = c?.attributes || c;
              if (!attrs?.id) continue;
              const productIndex = c?.productCollection?._index || attrs?.products?._index;
              const products: BrowserProduct[] = [];
              if (productIndex && typeof productIndex === 'object') {
                for (const pid of Object.keys(productIndex)) {
                  const p = productIndex[pid]?.attributes || productIndex[pid];
                  if (p) products.push(p as BrowserProduct);
                }
              }
              collections.push({
                id: attrs.id,
                name: attrs.name || '',
                products,
                status: attrs.status,
              });
            }
          }
        } catch (error: any) {
          console.log('WPP.catalog.getCollections failed:', error?.message);
        }

        // Method 2: CollectionStore.findQuery fallback
        if (collections.length === 0 && whatsappApi?.CollectionStore?.findQuery) {
          try {
            const results: any[] = await whatsappApi.CollectionStore.findQuery(userId);
            if (Array.isArray(results)) {
              for (const c of results) {
                const attrs = c?.attributes || c;
                if (!attrs?.id) continue;
                const productIndex = c?.productCollection?._index;
                const products: BrowserProduct[] = [];
                if (productIndex && typeof productIndex === 'object') {
                  for (const pid of Object.keys(productIndex)) {
                    const p = productIndex[pid]?.attributes || productIndex[pid];
                    if (p) products.push(p as BrowserProduct);
                  }
                }
                collections.push({
                  id: attrs.id,
                  name: attrs.name || '',
                  products,
                  status: attrs.status,
                });
              }
            }
          } catch (error: any) {
            console.log('CollectionStore.findQuery failed:', error?.message);
          }
        }

        return { collections };
      },
    );

    this.logger.log(`[browser] fetchCollections got ${result.collections.length} collections`);

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
   * Request a phone-number pairing code for an instance.
   * Returns the 8-character code (e.g. "ABCD1234") that the user enters
   * on their phone in WhatsApp → Linked Devices → Link with phone number instead.
   *
   * Phone format: international, digits only (e.g. "6285733556953" for Indonesia).
   */
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
