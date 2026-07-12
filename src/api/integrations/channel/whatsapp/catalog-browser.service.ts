/**
 * BrowserCatalogService
 * ---------------------------------------------------------------------
 * Singleton service that lazily launches a Puppeteer browser per WhatsApp
 * account (JID) to fetch catalog & collections via the internal
 * `window.WPP.whatsapp.functions.queryCatalog` API of web.whatsapp.com.
 *
 * Why this exists:
 *   WhatsApp's anti-bot/anti-scraping on the protocol level (Baileys)
 *   is very strict and causes `getCatalog()` to truncate results. The
 *   same catalog fetched via web.whatsapp.com (browser automation)
 *   returns the full list because WhatsApp's own frontend code handles
 *   pagination correctly.
 *
 * Design:
 *   - One Browser instance per JID (lazy start)
 *   - Browser is killed after IDLE_TIMEOUT_MS of inactivity
 *   - Session is persisted on disk per instance (BrowserSessionStore)
 *   - If no session exists, returns a QR code the caller must surface
 *     to the user for scanning
 *
 * Ported logic from:
 *   bedones-whatsapp/apps/whatsapp-connector/src/catalog/catalog.service.ts
 *   (Kelvin Yuli Andrian's own implementation, which proves this works)
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import puppeteer, { Browser, Page } from 'puppeteer-core';

import {
  BrowserCatalogConfig,
  BrowserCatalogOptions,
  BrowserCatalogResult,
  BrowserCollection,
  BrowserCollectionsOptions,
  BrowserCollectionsResult,
  BrowserProduct,
} from './catalog-browser.types';
import { BrowserSessionStore } from './session-store.browser';

// Return types for in-page scripts (kept as named interfaces to avoid
// TypeScript parser confusion with multi-line arrow type annotations)
interface InPageCatalogResult {
  catalog: BrowserProduct[];
  message?: string;
}

interface InPageCollectionsResult {
  collections: BrowserCollection[];
  message?: string;
}

interface InPageReadyResult {
  ready: boolean;
  reason?: string;
}

// JavaScript executed inside the browser page context — has access to
// window.WPP, window.Whatsapp, etc. Cannot reference any Node.js types.
// NOTE: must be self-contained, no closures over outer variables.
const FETCH_CATALOG_IN_PAGE = async (): Promise<InPageCatalogResult> => {
  // Type-loose since we're running in the browser context
  const wpp = (window as any).WPP;
  if (!wpp) {
    return { catalog: [], message: 'WPP not available — page did not load WhatsApp Web' };
  }

  const myUser = wpp.conn ? (wpp.conn.getMyUserId ? wpp.conn.getMyUserId() : null) : null;
  const userId = (myUser && myUser._serialized) || '';
  if (!userId) {
    return { catalog: [], message: 'User ID not found — not logged in' };
  }

  const whatsappApi = wpp.whatsapp as any;
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

  // Layer 1: queryCatalog with pagination cursor (most reliable)
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
      // queryCatalog unavailable on this WA version — fall through to next layer
      console.log('queryCatalog unavailable:', error?.message);
    }
  }

  // Layer 2: CatalogStore.findQuery (direct store access)
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

  // Layer 3: WPP.catalog.getMyCatalog (fallback)
  try {
    const myCatalog: any = await wpp.catalog?.getMyCatalog?.();
    const fallbackProducts = extractProductsFromCatalog(myCatalog);
    for (const product of fallbackProducts) {
      addProduct(product);
    }
  } catch (error: any) {
    console.log('getMyCatalog unavailable:', error?.message);
  }

  // Layer 4: last resort — getProducts with hardcoded cap
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
};

// In-page script: fetch all collections
const FETCH_COLLECTIONS_IN_PAGE = async (): Promise<InPageCollectionsResult> => {
  const wpp = (window as any).WPP;
  if (!wpp) {
    return { collections: [], message: 'WPP not available' };
  }

  const myUser = wpp.conn ? (wpp.conn.getMyUserId ? wpp.conn.getMyUserId() : null) : null;
  const userId = (myUser && myUser._serialized) || '';
  if (!userId) {
    return { collections: [], message: 'User ID not found' };
  }

  const whatsappApi = wpp.whatsapp as any;
  const collections: BrowserCollection[] = [];

  // Method 1: WPP.catalog.getCollections (preferred)
  try {
    const result: any = await wpp.catalog?.getCollections?.(userId);
    if (Array.isArray(result)) {
      for (const c of result) {
        const attrs = c?.attributes || c;
        if (!attrs?.id) continue;
        // Extract products from collection
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

  // Method 2: CatalogStore fallback (direct store access)
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
};

// In-page script: check if WA Web is ready
const IS_WA_READY_IN_PAGE = async (): Promise<InPageReadyResult> => {
  const wpp = (window as any).WPP;
  if (!wpp) return { ready: false, reason: 'WPP not loaded' };
  if (!wpp.isReady) {
    try {
      if (wpp.waitForReady) await wpp.waitForReady({ timeout: 30000 });
    } catch {
      return { ready: false, reason: 'WPP.waitForReady timed out' };
    }
  }
  const myUser = wpp.conn ? (wpp.conn.getMyUserId ? wpp.conn.getMyUserId() : null) : null;
  const userId = myUser ? myUser._serialized : null;
  if (!userId) return { ready: false, reason: 'No user logged in (need QR scan)' };
  return { ready: true };
};

export class BrowserCatalogService {
  private readonly logger = new Logger(BrowserCatalogService.name);
  private readonly config: BrowserCatalogConfig;

  // Per-JID browser instance
  private readonly browsers = new Map<string, Browser>();
  // Per-JID idle timer
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  // Per-JID QR code (when auth pending)
  private readonly pendingQr = new Map<string, string>();

  /**
   * Service locator — set by server.module.ts at bootstrap time so that
   * the BaileysStartupService (which is NOT NestJS-managed) can access
   * the singleton instance via `BrowserCatalogService.getInstance()`.
   *
   * Returns null if not initialized (e.g. when CATALOG_BROWSER_ENABLED=false).
   */
  private static instance: BrowserCatalogService | null = null;

  static getInstance(): BrowserCatalogService | null {
    return BrowserCatalogService.instance;
  }

  static setInstance(svc: BrowserCatalogService): void {
    BrowserCatalogService.instance = svc;
  }

  constructor(private readonly sessionStore: BrowserSessionStore) {
    this.config = this.loadConfig();
    if (this.config.enabled) {
      this.logger.log(
        `Browser catalog service enabled (maxSessions=${this.config.maxSessions}, idleTimeoutMs=${this.config.idleTimeoutMs})`,
      );
    }
    BrowserCatalogService.setInstance(this);
  }

  /**
   * Convenience static method: fetch catalog via browser, or throw if disabled.
   */
  static async fetchCatalogOrThrow(options: BrowserCatalogOptions): Promise<BrowserCatalogResult> {
    const svc = BrowserCatalogService.getInstance();
    if (!svc) {
      throw new BadRequestException(
        'Browser catalog service is not initialized. Set CATALOG_BROWSER_ENABLED=true to enable.',
      );
    }
    return svc.fetchCatalog(options);
  }

  /**
   * Convenience static method: fetch collections via browser.
   */
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
   * Load configuration from env vars (with sane defaults).
   */
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
      ],
    };
  }

  /**
   * Public entry: fetch catalog via browser.
   * If session is not authenticated, returns a result with qrCode.
   */
  async fetchCatalog(options: BrowserCatalogOptions): Promise<BrowserCatalogResult> {
    if (!this.config.enabled) {
      throw new BadRequestException('Browser catalog service is disabled. Set CATALOG_BROWSER_ENABLED=true to enable.');
    }

    const { jid, instanceName } = options;
    this.logger.log(`[browser] fetchCatalog jid=${jid} instance=${instanceName}`);

    const page = await this.getPage(jid, instanceName);

    try {
      // Wait for WA Web to be ready
      const ready = await page.evaluate(IS_WA_READY_IN_PAGE);
      if (!ready.ready) {
        const qrCode = await this.ensureQrCode(jid, instanceName, page);
        return {
          wuid: jid,
          numberExists: true,
          isBusiness: true,
          catalogLength: 0,
          catalog: [],
          truncated: false,
          nextCursor: null,
          source: 'browser',
          // Include QR code via cast — caller knows to check for it
          ...(qrCode ? ({ qrCode } as any) : {}),
        };
      }

      // Clear any pending QR (now authenticated)
      this.pendingQr.delete(jid);

      // Run the 4-layer fetch inside the browser
      const result = await page.evaluate(FETCH_CATALOG_IN_PAGE);

      if (result.message) {
        this.logger.warn(`[browser] fetchCatalog message: ${result.message}`);
      }

      this.logger.log(`[browser] fetchCatalog got ${result.catalog.length} products`);

      return {
        wuid: jid,
        numberExists: true,
        isBusiness: true,
        catalogLength: result.catalog.length,
        catalog: result.catalog,
        truncated: false,
        nextCursor: null,
        source: 'browser',
      };
    } finally {
      await page.close().catch(() => {});
      this.resetIdleTimer(jid);
    }
  }

  /**
   * Public entry: fetch collections via browser.
   */
  async fetchCollections(options: BrowserCollectionsOptions): Promise<BrowserCollectionsResult> {
    if (!this.config.enabled) {
      throw new BadRequestException('Browser catalog service is disabled. Set CATALOG_BROWSER_ENABLED=true to enable.');
    }

    const { jid, instanceName } = options;
    this.logger.log(`[browser] fetchCollections jid=${jid} instance=${instanceName}`);

    const page = await this.getPage(jid, instanceName);

    try {
      const ready = await page.evaluate(IS_WA_READY_IN_PAGE);
      if (!ready.ready) {
        const qrCode = await this.ensureQrCode(jid, instanceName, page);
        return {
          wuid: jid,
          name: null,
          numberExists: true,
          isBusiness: true,
          collectionsLength: 0,
          collections: [],
          source: 'browser',
          ...(qrCode ? ({ qrCode } as any) : {}),
        };
      }

      this.pendingQr.delete(jid);
      const result = await page.evaluate(FETCH_COLLECTIONS_IN_PAGE);

      if (result.message) {
        this.logger.warn(`[browser] fetchCollections message: ${result.message}`);
      }

      this.logger.log(`[browser] fetchCollections got ${result.collections.length} collections`);

      return {
        wuid: jid,
        name: null,
        numberExists: true,
        isBusiness: true,
        collectionsLength: result.collections.length,
        collections: result.collections,
        source: 'browser',
      };
    } finally {
      await page.close().catch(() => {});
      this.resetIdleTimer(jid);
    }
  }

  /**
   * Logout: kill browser + delete session for an instance.
   */
  async logout(instanceName: string, jid: string): Promise<void> {
    await this.killBrowser(jid);
    this.sessionStore.deleteSession(instanceName);
    this.pendingQr.delete(jid);
    this.logger.log(`[browser] Logged out instance=${instanceName} jid=${jid}`);
  }

  /**
   * Shutdown all browsers (for graceful app close).
   */
  async shutdownAll(): Promise<void> {
    const jids = Array.from(this.browsers.keys());
    await Promise.all(jids.map((j) => this.killBrowser(j)));
    this.logger.log(`[browser] Shutdown ${jids.length} browser(s)`);
  }

  /**
   * Get or launch a browser page for the given JID.
   */
  private async getPage(jid: string, instanceName: string): Promise<Page> {
    let browser = this.browsers.get(jid);
    if (!browser) {
      browser = await this.launchBrowser(jid, instanceName);
    }
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    return page;
  }

  /**
   * Launch a new browser for the JID, navigating to WhatsApp Web and
   * restoring session from disk if available.
   */
  private async launchBrowser(jid: string, instanceName: string): Promise<Browser> {
    if (this.browsers.size >= this.config.maxSessions) {
      // Evict oldest idle browser
      const oldestJid = this.browsers.keys().next().value;
      if (oldestJid) {
        this.logger.warn(`[browser] Max sessions reached, evicting oldest: ${oldestJid}`);
        await this.killBrowser(oldestJid);
      }
    }

    const userDataDir = this.sessionStore.userDataDir(instanceName);
    this.logger.log(`[browser] Launching Chromium for instance=${instanceName} jid=${jid}`);

    // Clean up stale SingletonLock file from previous crashed launches.
    // Chromium creates this lock file to prevent concurrent profile access,
    // but if a previous process crashed, the lock stays and blocks new launches.
    this.cleanStaleLocks(userDataDir);

    const browser = await puppeteer.launch({
      executablePath: this.config.executablePath,
      headless: this.config.headless,
      userDataDir,
      args: this.config.extraArgs,
      defaultViewport: { width: 1280, height: 800 },
      ignoreDefaultArgs: ['--enable-automation'],
      // Wait for initial page to be ready before returning
      protocolTimeout: 60000,
    });

    this.browsers.set(jid, browser);

    // Handle unexpected browser disconnect — clean up so next call can re-launch
    browser.on('disconnected', () => {
      this.logger.warn(`[browser] Browser disconnected for jid=${jid}, cleaning up`);
      this.browsers.delete(jid);
      const timer = this.idleTimers.get(jid);
      if (timer) {
        clearTimeout(timer);
        this.idleTimers.delete(jid);
      }
      this.pendingQr.delete(jid);
    });

    // Navigate to WA Web on the first page
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    await page.goto('https://web.whatsapp.com/', {
      waitUntil: 'networkidle2',
      timeout: 90000,
    });

    // Inject @wppconnect/wa-js library — required to access window.WPP API
    // (whatsapp-web.js bundles this, but since we use puppeteer-core directly,
    // we need to inject it ourselves)
    await this.injectWaJs(page);

    return browser;
  }

  /**
   * Inject @wppconnect/wa-js into the page and wait for WPP.isReady.
   * This library provides the window.WPP API we use for catalog fetching.
   */
  private async injectWaJs(page: Page): Promise<void> {
    const wppExists = await page.evaluate(() => typeof (window as any).WPP !== 'undefined');
    if (wppExists) {
      this.logger.log('[browser] WPP already loaded in page');
      return;
    }

    this.logger.log('[browser] Injecting @wppconnect/wa-js into page...');

    // Read wa-js from node_modules and inject via page.evaluate
    try {
      const waJsPath = require.resolve('@wppconnect/wa-js');
      const fs = await import('fs');
      const waJsCode = fs.readFileSync(waJsPath, 'utf8');
      await page.evaluate(waJsCode);
      this.logger.log(`[browser] wa-js injected (${waJsCode.length} chars)`);
    } catch (err) {
      this.logger.error(`[browser] Failed to inject wa-js: ${(err as Error).message}`);
      throw new BadRequestException(
        'Failed to inject @wppconnect/wa-js. Make sure it is installed: npm install @wppconnect/wa-js',
      );
    }

    // Wait for WPP to be ready
    try {
      await page.waitForFunction(
        () => (window as any).WPP && (window as any).WPP.isReady === true,
        { timeout: 30000 },
      );
      this.logger.log('[browser] WPP.isReady = true');
    } catch (err) {
      this.logger.warn('[browser] WPP.isReady timeout — continuing anyway');
    }

    // Give WA Web + WPP a few more seconds to stabilize
    await new Promise((r) => setTimeout(r, 5000));
  }

  /**
   * Ensure a QR code is available for the user to scan.
   * Returns the QR data URL if authentication is required.
   */
  private async ensureQrCode(jid: string, instanceName: string, page: Page): Promise<string | null> {
    // Check if we already have a pending QR for this JID
    const existing = this.pendingQr.get(jid);
    if (existing) return existing;

    // Try to extract QR from WA Web page
    try {
      // WA Web renders QR as a canvas — extract data URL
      const qrDataUrl = await page.evaluate(async () => {
        const wpp = (window as any).WPP;
        if (wpp?.conn?.getQRCode) {
          try {
            return await wpp.conn.getQRCode();
          } catch {
            /* fall through */
          }
        }
        // Fallback: scrape canvas
        const canvas = document.querySelector('canvas[aria-label="QR code"], canvas');
        if (canvas) {
          return (canvas as HTMLCanvasElement).toDataURL('image/png');
        }
        return null;
      });

      if (qrDataUrl) {
        this.pendingQr.set(jid, qrDataUrl);
        return qrDataUrl;
      }
    } catch (err) {
      this.logger.warn(`[browser] Failed to extract QR: ${(err as Error).message}`);
    }

    return null;
  }

  /**
   * Reset the idle timer — call after each activity.
   * When timer fires, the browser is killed to free memory.
   */
  private resetIdleTimer(jid: string): void {
    const existing = this.idleTimers.get(jid);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.logger.log(`[browser] Idle timeout for jid=${jid}, killing browser`);
      this.killBrowser(jid).catch((err) => {
        this.logger.error(`[browser] Failed to kill idle browser: ${(err as Error).message}`);
      });
    }, this.config.idleTimeoutMs);

    this.idleTimers.set(jid, timer);
  }

  /**
   * Remove stale Chromium lock files and kill orphan Chromium processes
   * left over from previous crashed launches.
   *
   * Chromium creates SingletonLock, SingletonCookie, and SingletonSocket
   * symlinks in the userDataDir. If a previous process crashed, these
   * locks persist and block new launches with "profile appears to be in
   * use by another Chromium process" error.
   */
  private cleanStaleLocks(userDataDir: string): void {
    // 1. Remove lock files/symlinks
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const lockFile of lockFiles) {
      const lockPath = join(userDataDir, lockFile);
      if (existsSync(lockPath)) {
        try {
          unlinkSync(lockPath);
          this.logger.log(`[browser] Removed stale lock: ${lockFile}`);
        } catch (err) {
          this.logger.warn(`[browser] Failed to remove ${lockFile}: ${(err as Error).message}`);
        }
      }
    }

    // 2. Kill orphan chromium processes (best-effort, ignore errors)
    // This handles the case where a previous Puppeteer crash left
    // chromium processes running and holding the profile.
    try {
      execSync('pkill -f chromium 2>/dev/null || true', { timeout: 5000 });
    } catch {
      // pkill exit code 1 = no process matched, ignore
    }
  }

  /**
   * Kill the browser for a JID and clean up timers.
   */
  private async killBrowser(jid: string): Promise<void> {
    const timer = this.idleTimers.get(jid);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(jid);
    }
    const browser = this.browsers.get(jid);
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        this.logger.warn(`[browser] Error closing browser: ${(err as Error).message}`);
      }
      this.browsers.delete(jid);
    }
    this.pendingQr.delete(jid);
  }
}
