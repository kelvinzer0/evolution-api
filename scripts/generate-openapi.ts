import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
const { version } = packageJson;

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Evolution API',
      version,
      description: 'WhatsApp API - OpenAPI Documentation',
      contact: {
        name: 'Evolution API',
        url: 'https://github.com/EvolutionAPI/evolution-api',
      },
    },
    servers: [
      {
        url: '/v1',
        description: 'API v1',
      },
    ],
    components: {
      securitySchemes: {
        apikey: {
          type: 'apiKey',
          name: 'apikey',
          in: 'header',
          description: 'API key for authentication',
        },
      },
    },
    security: [
      {
        apikey: [],
      },
    ],
  },
  apis: ['./src/api/routes/*.ts', './src/api/routes/**/*.ts'],
};

const spec = swaggerJsdoc(options);
writeFileSync('./openapi.json', JSON.stringify(spec, null, 2));
console.log('OpenAPI spec generated at ./openapi.json');
