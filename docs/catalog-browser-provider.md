# Browser-Based Catalog Provider

> Fetch full WhatsApp Business catalog & collections via web.whatsapp.com
> browser automation, bypassing Baileys' protocol-level truncation.

---

## Why This Exists

WhatsApp's anti-bot/anti-scraping on the **protocol level** (Baileys) is
much stricter than on the **browser level** (web.whatsapp.com). As a
result, Baileys' `getCatalog()` may return truncated results even when
the catalog has more products.

The browser-based provider launches a Puppeteer-controlled Chromium
session, navigates to web.whatsapp.com, and uses WhatsApp Web's own
internal `window.WPP.whatsapp.functions.queryCatalog` API — the same
code path WhatsApp's frontend uses. This returns the full catalog
without protocol-level truncation.

**Reference implementation**: ported from
[kelvinzer0/bedones-whatsapp](https://github.com/kelvinzer0/bedones-whatsapp)
which uses `whatsapp-web.js` + this same 4-layer fetch approach.

---

## How to Enable

### 1. Set environment variables

In your `docker-compose.yml` or env file:

```yaml
environment:
  CATALOG_BROWSER_ENABLED: 'true'
  # Optional tunables (with defaults):
  CATALOG_BROWSER_IDLE_TIMEOUT_MS: '600000'  # 10 minutes
  CATALOG_BROWSER_MAX_SESSIONS: '5'
  CATALOG_BROWSER_HEADLESS: 'true'           # true | false | shell
  # PUPPETEER_EXECUTABLE_PATH: /usr/bin/chromium-browser  # auto-set in Docker
```

### 2. Rebuild Docker image

The Dockerfile already installs Chromium + required fonts. Just rebuild:

```bash
docker compose build evolution-api
docker compose up -d evolution-api
```

**Image size increase**: ~200 MB (Chromium + fonts).

### 3. RAM requirements

Each active browser session uses ~500 MB RAM. The browser is killed
after `CATALOG_BROWSER_IDLE_TIMEOUT_MS` of inactivity, freeing memory.

**Recommendation**: ensure your Docker host has at least 1 GB free RAM
beyond existing workloads before enabling. For hosts with limited RAM
(< 4 GB total), set `CATALOG_BROWSER_MAX_SESSIONS=1` and a shorter idle
timeout (e.g. `CATALOG_BROWSER_IDLE_TIMEOUT_MS=120000` for 2 minutes).

---

## How to Use

### Fetch catalog via browser

```bash
curl -X POST "https://your-evolution-host/business/getCatalog/{instanceName}" \
  -H "Content-Type: application/json" \
  -H "apikey: YOUR_API_KEY" \
  -d '{
    "provider": "browser"
  }'
```

### Fetch collections via browser

```bash
curl -X POST "https://your-evolution-host/business/getCollections/{instanceName}" \
  -H "Content-Type: application/json" \
  -H "apikey: YOUR_API_KEY" \
  -d '{
    "provider": "browser"
  }'
```

### Backward compatible

If you don't pass `provider`, the existing Baileys path is used — no
behavior change for existing clients (n8n, Odoo, etc.).

---

## First-Time Setup: QR Scan

The first time you call the browser provider for a given instance, the
response will include a `qrCode` field (a `data:image/png;base64,...` URL)
because the browser session isn't authenticated yet.

**Response shape (pending auth)**:
```json
{
  "wuid": "1234567890@s.whatsapp.net",
  "numberExists": true,
  "isBusiness": true,
  "catalogLength": 0,
  "catalog": [],
  "truncated": false,
  "nextCursor": null,
  "source": "browser",
  "qrCode": "data:image/png;base64,..."
}
```

**To authenticate**:
1. Render the `qrCode` data URL as an image (any browser, or `qrencode -t ANSIUTF8`)
2. On your phone, open WhatsApp → Settings → Linked Devices → Link a Device
3. Scan the QR code
4. Wait 5–10 seconds for WA Web to log in
5. Call the endpoint again — you'll get the full catalog

The session is persisted at `instances/{instanceName}/browser-session/`
and survives browser restarts, container restarts, and host reboots (as
long as the volume `evolution-instances` is preserved).

**You only need to scan the QR code ONCE per WhatsApp account.** The
browser session is independent from the Baileys session — you'll have
two linked devices on your phone (one for Baileys messaging, one for
browser catalog fetch).

---

## How It Works (Internal)

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Evolution API                                           │
│                                                          │
│  ┌──────────────────┐    ┌──────────────────────────┐  │
│  │ BaileysStartup   │    │ BrowserCatalogService    │  │
│  │ Service          │───►│ (singleton, lazy-launch) │  │
│  │                  │    │                          │  │
│  │ fetchCatalog()   │    │  - Puppeteer Chromium    │  │
│  │   if provider=   │    │  - One Browser per JID   │  │
│  │   'browser'      │    │  - Idle kill (10 min)    │  │
│  │   → delegate     │    │  - Persistent session    │  │
│  └──────────────────┘    └──────────────────────────┘  │
│                                                          │
│  Session files: instances/{name}/browser-session/       │
└─────────────────────────────────────────────────────────┘
```

### 4-Layer Catalog Fetch

Inside the browser page context, the service tries 4 strategies in
order, deduplicating products by ID:

1. **`WPP.whatsapp.functions.queryCatalog(userId, afterToken)`** — paginated
   cursor loop (most reliable, primary path)
2. **`WPP.whatsapp.CatalogStore.findQuery(userId)`** — direct store access
3. **`WPP.catalog.getMyCatalog()`** — high-level wrapper
4. **`WPP.catalog.getProducts(userId, 999)`** — last-resort hardcoded cap

### Collections Fetch

Uses `WPP.catalog.getCollections(userId)` with
`CollectionStore.findQuery` fallback.

### Resource Management

- One `Browser` instance per JID, lazy-started on first request
- Browser is killed after `CATALOG_BROWSER_IDLE_TIMEOUT_MS` (default 10 min)
- Max concurrent sessions capped at `CATALOG_BROWSER_MAX_SESSIONS` (default 5)
- When limit reached, oldest idle browser is evicted
- All browsers killed on app shutdown

---

## Files Changed

| File | Purpose |
|---|---|
| `src/api/integrations/channel/whatsapp/catalog-browser.service.ts` | Core service — 4-layer fetch, browser pool, idle timeout |
| `src/api/integrations/channel/whatsapp/catalog-browser.types.ts` | Type definitions |
| `src/api/integrations/channel/whatsapp/catalog-browser.module.ts` | NestJS module wiring |
| `src/api/integrations/channel/whatsapp/session-store.browser.ts` | Persistent session storage |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | Routing: `provider=browser` delegates to BrowserCatalogService |
| `src/api/dto/business.dto.ts` | Added `provider?: 'baileys' \| 'browser'` field |
| `src/validate/business.schema.ts` | JSON Schema for the new field |
| `src/api/server.module.ts` | Bootstrap singleton instance of BrowserCatalogService |
| `Dockerfile` | Install Chromium + fonts, set PUPPETEER env vars |
| `package.json` | Added `puppeteer-core@^23.11.1` dependency |
| `env.example` | Documented new env vars |

---

## Troubleshooting

### `Browser catalog service is disabled`

Set `CATALOG_BROWSER_ENABLED=true` and restart the container.

### `Browser catalog service is not initialized`

The service constructor failed. Check logs for the initialization
error. Likely cause: missing Chromium binary — verify
`PUPPETEER_EXECUTABLE_PATH` points to a real Chromium binary
(`ls -la /usr/bin/chromium-browser` inside the container).

### QR code never appears

Make sure `web.whatsapp.com` is reachable from inside the container.
Try `curl -I https://web.whatsapp.com/` from inside the container.

### Browser OOM kills

Check container memory usage:
```bash
docker stats evolution_api
```

If the container hits the host memory limit, either:
- Increase host RAM
- Reduce `CATALOG_BROWSER_MAX_SESSIONS` to 1
- Reduce `CATALOG_BROWSER_IDLE_TIMEOUT_MS` to 60000 (1 minute)

### Session expired

If WA Web session expires (rare, happens after ~30 days inactive),
delete the session dir and scan QR again:

```bash
docker exec evolution_api rm -rf /evolution/instances/{instanceName}/browser-session
```

Then call the endpoint again to get a fresh QR code.

---

## Limitations

- **First call is slow**: Browser launch + WA Web load = 10–30 seconds.
  Subsequent calls within the idle window are fast (~2 seconds).
- **QR scan required once per WhatsApp account**: Browser session is
  independent from Baileys session. You'll see two linked devices on
  your phone.
- **Memory heavy**: Each active browser = ~500 MB RAM. Plan capacity
  accordingly.
- **Compliance**: Browser automation is against WhatsApp ToS in
  principle, but enforcement is rare for legitimate catalog reads.
  Use at your own risk.

---

*Added in evolution-api v2.3.7-catalog-browser*
*Branch: `feature/catalog-browser-provider`*
