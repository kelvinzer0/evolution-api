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

### TIER 3f — moduleResolution moderno + proxy agents (CONCLUÍDO)
- `tsconfig`: `module: preserve` + `moduleResolution: bundler`; **removidos `baseUrl` e `ignoreDeprecations`**
  (dívida de deprecação do TS 6/7 eliminada por completo). Paths resolvem relativo ao tsconfig (tsc/tsup/tsx).
- `https-proxy-agent` 7→9 e `socks-proxy-agent` 8→10 (majors ESM-only, agora resolvíveis).
- Validado: tsc/lint/build + boot do `dev:server` carregando todos os módulos.

### TIER 4 — Prisma 6→7 (CONCLUÍDO — driver adapters + prisma-client)
Migração estrutural completa e validada (dev + produção):
- `prisma`/`@prisma/client` **7.8.0** + `@prisma/adapter-pg` + `@prisma/adapter-mariadb`.
- generator `prisma-client-js` → `prisma-client` com `output ./generated/client` (TS gerado) nos 3 schemas;
  `url` removida do datasource (proibida no v7).
- `prisma.config.ts`: connection string (`DATABASE_CONNECTION_URI`) + seleção dinâmica de schema/migrations
  por `DATABASE_PROVIDER` (multi-provider postgresql/mysql/psql_bouncer).
- `repository.service.ts`: instancia `PrismaClient` com driver adapter conforme provider.
- Alias `@prisma/client` → client gerado no tsconfig (tsx/tsc) **e** no tsup (`noExternal` + esbuild alias),
  pois o esbuild não honra `paths` do tsconfig.
- `tsup`: `shims: true` (shim de `import.meta.url` p/ o client v7 no bundle CJS) + `platform: node`.
- `start:prod` usa `dist/main.js` (CJS); o ESM puro quebra por imports sem extensão do `@figuro/chatwoot-sdk`.
- `prisma/generated/` no `.gitignore` (gerado por provider via `db:generate`).
- **Validado:** `db:generate` (postgres+mysql), tsc, lint, build, e boot **dev (tsx) + produção (`node dist/main.js`,
  HTTP ON:3210)** até a query real (`DriverAdapterError: AuthenticationFailed` = credenciais/infra, não código).

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

- [x] **Tier 0** — Baileys `rc.9 → rc13` + remoção do patch obsoleto (waveform já upstream). tsc/build limpos.
- [x] **Tier 1** — bumps seguros (axios 1.17, sentry, pg, socket.io, multer 2.1, etc). Fix: cast `as string` em `content-type` (axios 1.17 endureceu `AxiosHeaderValue`).
- [x] **Tier 2** — uuid 14, dotenv 17, node-cron 4, i18next 26, class-validator 0.15, mime-types 3, amqplib 2 (+fix de `port:Number`), cuid2 3, pusher 5.3, **undici 8**.
- [x] **Tier 3** — ESLint 10 (flat config, `import-x`), Express 5 (rotas wildcard + casts `req.params`), OpenAI 6 (`runs.retrieve/submitToolOutputs`), Redis 6 (casts RESP3), TypeScript 6 (`ignoreDeprecations`).
- [~] **Tier 4** — Prisma mantido em **6.19.x** (estável). Prisma 7 NÃO aplicado (ESM-only + driver adapters incompatíveis com CommonJS/multi-provider). Documentado como spike opcional.

### Mantidos na faixa do peer do Baileys rc13 (não subir sem o Baileys subir junto)
`audio-decode@2`, `link-preview-js@3`, `pino@9`, `jimp@1.6` — peers `peerOptional` do Baileys; subir gera ERESOLVE e risco de quebrar áudio/preview internos.

### ~~Adiados~~ → CONCLUÍDOS (Tier 3f)
`https-proxy-agent@9`, `socks-proxy-agent@10` foram subidos após migrar `moduleResolution` para `bundler`.
A dívida de `moduleResolution`/`baseUrl` (TS 7) foi eliminada.

### Correção crítica de runtime — `whatsapp-rust-bridge` (override)
O Baileys rc13 passou a depender de `whatsapp-rust-bridge@0.5.4`, cujo `package.json` é ESM-only
(`exports` só com `import`). Em contexto CommonJS (tsx/`require`) o app **não sobe**
(`ERR_PACKAGE_PATH_NOT_EXPORTED`). A versão **0.5.5** adiciona a condição `require`. Fixado via:
```json
"overrides": { "whatsapp-rust-bridge": "0.5.5" }
```
Validado: `require('whatsapp-rust-bridge')` resolve e o `dev:server` inicializa toda a stack
(RedisCache, CacheService, WA MODULE, Prisma) até o ponto de conectar a infraestrutura.

### Notas operacionais
- Após `rm -rf node_modules` (instalação limpa), rodar **`npm run db:generate`** antes do build — o `postinstall` só roda `patch-package`, não gera o Prisma Client.
- **Segurança**: `npm audit` caiu de **57 → 9**. As 9 restantes são travadas por upstream (`axios` aninhado do `@figuro/chatwoot-sdk`; `link-preview-js@3` exigido pelo Baileys) ou dev-only via `commitizen` (`lodash`/`tmp`). `npm audit fix --force` não aplicado para não quebrar.

### Pendente (requer ação do usuário)
- [ ] **Smoke test de envio real**: conectar instância via QR e enviar `sendButtons` (5 tipos), `sendList` e `sendCarousel` para o número de teste; validar render no WhatsApp Web/Desktop + mobile e o áudio PTT.
