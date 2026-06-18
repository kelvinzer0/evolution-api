import { RouterBroker } from '@api/abstract/abstract.router';
import { NumberDto } from '@api/dto/chat.dto';
import { businessController } from '@api/server.module';
import { createMetaErrorResponse } from '@utils/errorResponse';
import { catalogSchema, collectionsSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

/**
 * Business Router - Handles WhatsApp Business catalog operations
 * @tags Business
 */
export class BusinessRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      /**
       * @swagger
       * /business/getCatalog/{instanceName}:
       *   post:
       *     tags: [Business]
       *     summary: Get WhatsApp Business catalog
       *     description: Fetches all products from a WhatsApp Business catalog with automatic pagination
       *     security:
       *       - apikey: []
       *     parameters:
       *       - in: path
       *         name: instanceName
       *         required: true
       *         schema:
       *           type: string
       *         description: Instance name
       *     requestBody:
       *       required: true
       *       content:
       *         application/json:
       *           schema:
       *             $ref: '#/components/schemas/CatalogRequest'
       *     responses:
       *       200:
       *         description: Catalog retrieved successfully
       *         content:
       *           application/json:
       *             schema:
       *               $ref: '#/components/schemas/CatalogResponse'
       *       400:
       *         description: Bad request
       *         content:
       *           application/json:
       *             schema:
       *               $ref: '#/components/schemas/ErrorResponse'
       */
      .post(this.routerPath('getCatalog'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<NumberDto>({
            request: req,
            schema: catalogSchema,
            ClassRef: NumberDto,
            execute: (instance, data) => businessController.fetchCatalog(instance, data),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          // Log error for debugging
          console.error('Business catalog error:', error);

          // Use utility function to create standardized error response
          const errorResponse = createMetaErrorResponse(error, 'business_catalog');
          return res.status(errorResponse.status).json(errorResponse);
        }
      })

      /**
       * @swagger
       * /business/getCollections/{instanceName}:
       *   post:
       *     tags: [Business]
       *     summary: Get WhatsApp Business collections
       *     description: Fetches all collections with their products from a WhatsApp Business account
       *     security:
       *       - apikey: []
       *     parameters:
       *       - in: path
       *         name: instanceName
       *         required: true
       *         schema:
       *           type: string
       *         description: Instance name
       *     requestBody:
       *       required: true
       *       content:
       *         application/json:
       *           schema:
       *             $ref: '#/components/schemas/CollectionsRequest'
       *     responses:
       *       200:
       *         description: Collections retrieved successfully
       *         content:
       *           application/json:
       *             schema:
       *               $ref: '#/components/schemas/CollectionsResponse'
       *       400:
       *         description: Bad request
       *         content:
       *           application/json:
       *             schema:
       *               $ref: '#/components/schemas/ErrorResponse'
       */
      .post(this.routerPath('getCollections'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<NumberDto>({
            request: req,
            schema: collectionsSchema,
            ClassRef: NumberDto,
            execute: (instance, data) => businessController.fetchCollections(instance, data),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          // Log error for debugging
          console.error('Business collections error:', error);

          // Use utility function to create standardized error response
          const errorResponse = createMetaErrorResponse(error, 'business_collections');
          return res.status(errorResponse.status).json(errorResponse);
        }
      });
  }

  public readonly router: Router = Router();
}
