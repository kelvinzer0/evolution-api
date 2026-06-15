// Mirrors evolution-go/pkg/core/store.go
// Persists license + instance ID as key/value rows in RuntimeConfig (Prisma).

import { PrismaRepository } from '@api/repository/repository.service';
import { randomUUID } from 'crypto';
import { hostname, networkInterfaces } from 'os';

import { ConfigKey, RuntimeData } from './model';

let globalDB: PrismaRepository | null = null;

export function setDB(db: PrismaRepository): void {
  globalDB = db;
}

function requireDB(): PrismaRepository {
  if (!globalDB) {
    throw new Error('licensing: database not set, call setDB first');
  }
  return globalDB;
}

async function getConfig(key: string): Promise<string | null> {
  const db = requireDB();
  const row = await db.runtimeConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function setConfig(key: string, value: string): Promise<void> {
  const db = requireDB();
  await db.runtimeConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

async function deleteConfig(key: string): Promise<void> {
  const db = requireDB();
  await db.runtimeConfig.deleteMany({ where: { key } });
}

export async function loadRuntimeData(): Promise<RuntimeData | null> {
  const apiKey = await getConfig(ConfigKey.APIKey);
  if (!apiKey) return null;

  const tier = (await getConfig(ConfigKey.Tier)) ?? '';
  const customerIDStr = (await getConfig(ConfigKey.CustomerID)) ?? '';
  const customerId = parseInt(customerIDStr, 10) || 0;

  return { apiKey, tier, customerId };
}

export async function saveRuntimeData(rd: RuntimeData): Promise<void> {
  await setConfig(ConfigKey.APIKey, rd.apiKey);
  await setConfig(ConfigKey.Tier, rd.tier);
  if (rd.customerId > 0) {
    await setConfig(ConfigKey.CustomerID, String(rd.customerId));
  }
}

export async function removeRuntimeData(): Promise<void> {
  await deleteConfig(ConfigKey.APIKey);
  await deleteConfig(ConfigKey.Tier);
  await deleteConfig(ConfigKey.CustomerID);
}

export async function loadOrCreateInstanceID(): Promise<string> {
  const existing = await getConfig(ConfigKey.InstanceID);
  if (existing && existing.length === 36) return existing;

  // Generate hardware-based instance ID (hostname + primary MAC).
  const id = generateHardwareID() || randomUUID();
  await setConfig(ConfigKey.InstanceID, id);
  return id;
}

function generateHardwareID(): string {
  const host = hostname() ?? '';
  const mac = getPrimaryMAC();
  if (!host && !mac) return '';

  const seed = `${host}|${mac}`;
  const buf = Buffer.alloc(16);
  buf.write(seed, 0, Math.min(seed.length, 16), 'utf8');
  for (let i = 16; i < seed.length; i++) {
    buf[i % 16] ^= seed.charCodeAt(i);
  }
  buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
  buf[8] = (buf[8] & 0x3f) | 0x80; // variant
  return formatUUID(buf);
}

function getPrimaryMAC(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.internal) continue;
      if (!iface.mac || iface.mac === '00:00:00:00:00:00') continue;
      return iface.mac;
    }
  }
  return '';
}

function formatUUID(b: Buffer): string {
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
