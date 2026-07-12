/**
 * Persistent session store for the browser-based catalog service.
 *
 * WhatsApp Web (whatsapp-web.js style) stores session as a set of files
 * in a directory. We mirror this pattern, storing per-instance sessions
 * under `${INSTANCE_DIR}/${instanceName}/browser-session/`.
 *
 * This survives across browser restarts so the user only needs to scan
 * the QR code ONCE per WhatsApp account.
 */

import { Logger } from '@config/logger.config';
import { INSTANCE_DIR } from '@config/path.config';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const SESSION_SUBDIR = 'browser-session';

export interface StoredSessionData {
  [key: string]: unknown;
}

export class BrowserSessionStore {
  private readonly logger = new Logger(BrowserSessionStore.name);

  /**
   * Resolve the session directory for an instance.
   */
  private sessionDir(instanceName: string): string {
    return join(INSTANCE_DIR, instanceName, SESSION_SUBDIR);
  }

  /**
   * Check if a saved session exists for this instance.
   */
  hasSession(instanceName: string): boolean {
    const dir = this.sessionDir(instanceName);
    if (!existsSync(dir)) return false;
    const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
    return files.length > 0;
  }

  /**
   * Load all session files for an instance.
   * Returns a map of filename → file content (JSON-parsed when possible).
   */
  loadSession(instanceName: string): StoredSessionData {
    const dir = this.sessionDir(instanceName);
    const result: StoredSessionData = {};

    if (!existsSync(dir)) return result;

    for (const file of readdirSync(dir)) {
      if (file.startsWith('.')) continue;
      const fullPath = join(dir, file);
      try {
        const raw = readFileSync(fullPath, 'utf8');
        try {
          result[file] = JSON.parse(raw);
        } catch {
          result[file] = raw;
        }
      } catch (err) {
        this.logger.warn(`Failed to read session file ${file}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /**
   * Save session data back to disk.
   * Each top-level key becomes a file; values are JSON-serialized.
   */
  saveSession(instanceName: string, data: StoredSessionData): void {
    const dir = this.sessionDir(instanceName);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    for (const [file, value] of Object.entries(data)) {
      const fullPath = join(dir, file);
      const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      try {
        writeFileSync(fullPath, serialized, 'utf8');
      } catch (err) {
        this.logger.warn(`Failed to write session file ${file}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Delete the entire session for an instance (logout).
   */
  deleteSession(instanceName: string): void {
    const dir = this.sessionDir(instanceName);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      this.logger.log(`Deleted browser session for instance ${instanceName}`);
    }
  }

  /**
   * Path where session lives (for Puppeteer's userDataDir option).
   * Using userDataDir lets WhatsApp Web store IndexedDB + LocalStorage
   * so we don't need to manually restore session tokens.
   */
  userDataDir(instanceName: string): string {
    const dir = this.sessionDir(instanceName);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
}
