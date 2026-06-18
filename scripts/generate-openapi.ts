import swaggerJsdoc from 'swagger-jsdoc';
import { writeFileSync } from 'fs';
import { version } from '../package.json';

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
