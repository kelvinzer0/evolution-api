# Atualização Agressiva de Dependências — Evolution API

> Guia executável e registro da atualização de dependências (Baileys + ecossistema),
> preservando a implementação de **botões interativos, listas e carrosséis** (commit `35a4bd44`).

## Objetivo

Deixar a API em dia com as últimas versões de forma **agressiva, porém sem estragar**, validando
por **build/typecheck** e por **envio real** de `sendButtons`/`sendList`/`sendCarousel` para um número
de teste. A implementação interativa (nós `<biz>` via `additionalNodes` no `relayMessage` do Baileys)
**não pode regredir**.

## Descobertas de risco confirmadas

| Item | Conclusão |
|------|-----------|
| `relayMessage({ additionalNodes })` | ✅ Continua idêntico no rc13 (`stanza.content.push(...additionalNodes)`). Botões/carrossel/lista preservados. |
| Patch waveform (`requiresWaveformProcessing`) | ⚠️ Já incorporado upstream no rc13. Patch local fica **obsoleto** → remover. |
| Sem `overrides`/`resolutions` | OK — atualização direta. |
| Changelog rc10→rc13 | Sem breaking changes nas APIs usadas. |
| **Prisma 7** | 🔴 ESM-only, driver adapters, `prisma.config.ts`, não carrega env. Conflita com CommonJS + multi-provider + `runWithProvider.js`. |
| **Express 5** | 🟡 path-to-regexp v8: wildcard `/assets/*` quebra; `req.params[0]` muda; `req.query` vira getter. |
| **ESLint 8→10** | 🟡 exige flat config (`eslint.config.mjs`). |
| **OpenAI 4→6** | 🟡 `beta.threads.*` + `chat.completions.create`; Zod v4. |
| **Redis 4→6** | 🟡 `EXISTS` retorna número (não boolean). |
| **amqplib 0.10→2.0** | 🟢 `amqplib/callback_api` continua disponível; mínimo Node 18. |
| TS 6, dotenv 17, node-cron 4, uuid 14, undici 8, i18next 26, proxy-agents | 🟢/🟡 baixo a médio risco. |

## Estratégia: atualização em camadas (tiers)

Cada tier termina com `tsc --noEmit` + `npm run build` + lint e (a partir do Tier 0) **smoke test de envio real**.
Branch: `chore/deps-aggressive-upgrade`. Commit por tier.

### TIER 0 — Baileys rc.9 → rc13 + remoção do patch obsoleto
- `package.json`: `baileys` `7.0.0-rc.9` → `7.0.0-rc13`.
- Remover `patches/baileys+7.0.0-rc.6.patch` (correção já no rc13).
- `npm install` (conferir patch-package sem patch órfão).
- Validar: build + envio real de `sendButtons` (5 tipos), `sendList`, `sendCarousel` + áudio PTT.

### TIER 1 — Bumps minor/patch seguros (mesmo major)
axios 1.17, @sentry/node 10.56, pg 8.21, dayjs 1.11.21, jimp 1.6.1, socket.io(+client) 4.8.3,
minio 8.0.7, mediainfo.js 0.3.7, libphonenumber-js 1.13.5, jsonwebtoken 9.0.3, cors 2.8.6,
fetch-socks 1.3.3, multer 2.1.1, @aws-sdk/client-sqs (3.x), @prisma/client+prisma 6.19.x,
undici 7.27 (7.x). Dev: prettier 3.8.3, tsx 4.22.4, @typescript-eslint/* 8.60.1, lint-staged 16.4,
eslint-plugin-prettier 5.5.6, @types/node 24.13.

### TIER 2 — Majors de baixo/médio risco
uuid 14, dotenv 17, node-cron 4, i18next 26, pino 10, @paralleldrive/cuid2 3, audio-decode 3,
link-preview-js 4, pusher 5.3, class-validator 0.15, eslint-plugin-simple-import-sort 13.
Proxies/HTTP: undici 8, https-proxy-agent 9, socks-proxy-agent 10 (foco em `src/utils/makeProxyAgent.ts`).
MIME: mime-types 3 (+@types); avaliar remover `@types/mime` (mime v4 traz tipos próprios).
amqplib 2.0 (manter callback_api).

### TIER 3 — Majors de alto risco (um de cada vez)
1. ESLint 8→10 + `eslint.config.mjs` (flat config) + commitlint 21 + lint-staged 17.
2. Express 4→5 (+@types/express 5): `/assets/*` → `/assets/*splat`, `req.params[0]` → `req.params.splat`,
   revisar `res.status().send()`, `req.query` getter.
3. OpenAI 4→6: `src/api/integrations/chatbot/openai/services/openai.service.ts`.
4. Redis 4→6: `src/cache/rediscache.ts` (`exists()` retorna número).
5. TypeScript 5→6: `tsc --noEmit` + tsup.

### TIER 4 — Prisma 6→7 (spike opcional, NÃO bloqueante)
Manter 6.19.x como estado estável entregue. Avaliar Prisma 7 em branch `spike/prisma-7`
(adapter-pg + `prisma.config.ts`, validar multi-provider/CommonJS). Só promover se passar em todos os testes.

## Verificação end-to-end

Após cada tier: `npm install` → `npm run lint:check` → `npx tsc --noEmit` → `npm run build`.

Smoke test de envio real (a partir do Tier 0):
1. `npm run dev:server`, criar instância, conectar via QR.
2. Enviar para o número de teste e confirmar renderização em WhatsApp Web/Desktop + mobile:
   - `POST /message/sendButtons` — `reply`, `url`, `call`, `copy`, `pix`.
   - `POST /message/sendList` — sections/rows; validar `listResponseMessage`.
   - `POST /message/sendCarousel` — múltiplos cards (e 1 card sem imagem → nativeFlow direto).
3. Clicar nos botões e confirmar `interactiveResponseMessage`/`buttonsResponseMessage`.
4. Testar áudio PTT (validar remoção do patch de waveform).

**Critério de sucesso**: build/lint limpos + interativos renderizando e respondendo idênticos ao estado anterior.

## Progresso

- [ ] Tier 0 — Baileys rc13 + remoção do patch
- [ ] Tier 1 — bumps seguros
- [ ] Tier 2 — majors baixo/médio risco
- [ ] Tier 3 — majors alto risco
- [ ] Tier 4 — Prisma 7 (spike opcional)
