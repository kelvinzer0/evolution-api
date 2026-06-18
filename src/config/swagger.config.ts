import swaggerJsdoc from 'swagger-jsdoc';
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
      schemas: {
        InstanceDto: {
          type: 'object',
          properties: {
            instanceName: {
              type: 'string',
              description: 'Instance name',
            },
          },
        },
        NumberDto: {
          type: 'object',
          properties: {
            number: {
              type: 'string',
              description: 'Phone number (e.g., 5511999999999)',
            },
          },
        },
        CatalogRequest: {
          type: 'object',
          properties: {
            number: {
              type: 'string',
              description: 'Phone number of the business account',
            },
            limit: {
              type: 'number',
              description: 'Number of products to fetch (default: 50)',
              default: 50,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
        },
        CollectionsRequest: {
          type: 'object',
          properties: {
            number: {
              type: 'string',
              description: 'Phone number of the business account',
            },
            limit: {
              type: 'number',
              description: 'Number of collections to fetch (default: 100)',
              default: 100,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
        },
        Product: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Product ID',
            },
            name: {
              type: 'string',
              description: 'Product name',
            },
            description: {
              type: 'string',
              description: 'Product description',
            },
            price: {
              type: 'number',
              description: 'Product price',
            },
            currency: {
              type: 'string',
              description: 'Currency code',
            },
            availability: {
              type: 'string',
              enum: ['in stock', 'out of stock', 'preorder'],
              description: 'Product availability status',
            },
            image: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Product image URLs',
            },
          },
        },
        CatalogCollection: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Collection ID',
            },
            name: {
              type: 'string',
              description: 'Collection name',
            },
            products: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/Product',
              },
            },
          },
        },
        CatalogResponse: {
          type: 'object',
          properties: {
            wuid: {
              type: 'string',
              description: 'WhatsApp user ID',
            },
            numberExists: {
              type: 'boolean',
              description: 'Whether the number exists on WhatsApp',
            },
            isBusiness: {
              type: 'boolean',
              description: 'Whether the account is a business account',
            },
            catalogLength: {
              type: 'number',
              description: 'Total number of products fetched',
            },
            catalog: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/Product',
              },
            },
          },
        },
        CollectionsResponse: {
          type: 'object',
          properties: {
            wuid: {
              type: 'string',
              description: 'WhatsApp user ID',
            },
            name: {
              type: 'string',
              description: 'Business name',
            },
            numberExists: {
              type: 'boolean',
              description: 'Whether the number exists on WhatsApp',
            },
            isBusiness: {
              type: 'boolean',
              description: 'Whether the account is a business account',
            },
            collectionsLength: {
              type: 'number',
              description: 'Total number of collections',
            },
            collections: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/CatalogCollection',
              },
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'number',
              description: 'HTTP status code',
            },
            error: {
              type: 'string',
              description: 'Error message',
            },
            message: {
              type: 'string',
              description: 'Detailed error message',
            },
          },
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

export const swaggerSpec = swaggerJsdoc(options);
