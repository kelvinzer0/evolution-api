import 'dotenv/config';

import path from 'node:path';

import { defineConfig, env } from 'prisma/config';

// Prisma 7: a connection string saiu do schema e vive aqui (datasource.url),
// e o schema/migrations são selecionados dinamicamente pelo DATABASE_PROVIDER
// (mesma lógica multi-provider do runWithProvider.js).
const provider = process.env.DATABASE_PROVIDER ?? 'postgresql';

const schemaFile =
  provider === 'mysql'
    ? 'mysql-schema.prisma'
    : provider === 'psql_bouncer'
      ? 'psql_bouncer-schema.prisma'
      : 'postgresql-schema.prisma';

export default defineConfig({
  schema: path.join('prisma', schemaFile),
  // Os scripts db:* copiam as migrations do provider ativo para prisma/migrations
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: env('DATABASE_CONNECTION_URI'),
  },
});
