import { RouterBroker } from '@api/abstract/abstract.router';
import { getCatalogDto, getCollectionsDto, requestPairingCodeDto } from '@api/dto/business.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { businessController } from '@api/server.module';
import { createMetaErrorResponse } from '@utils/errorResponse';
import { catalogSchema, collectionsSchema, pairingCodeSchema } from '@validate/validate.schema';
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
       *     description: Fetches all products from a WhatsApp Business catalog with automatic pagination. Use `provider: "browser"` to bypass Baileys protocol-level truncation (requires CATALOG_BROWSER_ENABLED=true and one-time QR/pairing auth).
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
          const response = await this.dataValidate<getCatalogDto>({
            request: req,
            schema: catalogSchema,
            ClassRef: getCatalogDto,
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
       *     description: Fetches all collections with their products from a WhatsApp Business account. Use `provider: "browser"` to bypass Baileys protocol-level truncation.
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
          const response = await this.dataValidate<getCollectionsDto>({
            request: req,
            schema: collectionsSchema,
            ClassRef: getCollectionsDto,
            execute: (instance, data) => businessController.fetchCollections(instance, data),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          console.error('Business collections error:', error);
          const errorResponse = createMetaErrorResponse(error, 'business_collections');
          return res.status(errorResponse.status).json(errorResponse);
        }
      })

      /**
       * @swagger
       * /business/requestPairingCode/{instanceName}:
       *   post:
       *     tags: [Business]
       *     summary: Request phone-number pairing code for browser catalog session
       *     description: Generates an 8-character pairing code that the user enters on their phone in WhatsApp → Linked Devices → Link a Device → Link with phone number instead. Requires CATALOG_BROWSER_ENABLED=true.
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
       *             type: object
       *             required: [phone]
       *             properties:
       *               phone:
       *                 type: string
       *                 description: Phone number in international format, digits only (e.g. "6285733556953" for Indonesia)
       *                 example: "6285733556953"
       *     responses:
       *       200:
       *         description: Pairing code generated
       *         content:
       *           application/json:
       *             schema:
       *               type: object
       *               properties:
       *                 instance:
       *                   type: string
       *                 phone:
       *                   type: string
       *                 pairingCode:
       *                   type: string
       *                   description: 8-character code (e.g. "ABCD1234")
       *                 expiresIn:
       *                   type: number
       *                   description: Code validity in seconds (60)
       *                 instructions:
       *                   type: string
       */
      .post(this.routerPath('requestPairingCode'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<requestPairingCodeDto>({
            request: req,
            schema: pairingCodeSchema,
            ClassRef: requestPairingCodeDto,
            execute: (instance, data) => businessController.requestPairingCode(instance, data),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          console.error('Pairing code error:', error);
          const errorResponse = createMetaErrorResponse(error, 'pairing_code');
          return res.status(errorResponse.status).json(errorResponse);
        }
      })

      /**
       * @swagger
       * /business/getAuthState/{instanceName}:
       *   get:
       *     tags: [Business]
       *     summary: Get browser catalog session auth state
       *     description: Returns the current authentication state of the browser-based catalog session (qrCode, pairingCode, ready). Use this to poll for auth status from the pairing UI.
       *     security:
       *       - apikey: []
       *     parameters:
       *       - in: path
       *         name: instanceName
       *         required: true
       *         schema:
       *           type: string
       *     responses:
       *       200:
       *         description: Auth state
       *         content:
       *           application/json:
       *             schema:
       *               type: object
       *               properties:
       *                 instance:
       *                   type: string
       *                 enabled:
       *                   type: boolean
       *                 ready:
       *                   type: boolean
       *                   description: True if browser session is authenticated and ready
       *                 qrCode:
       *                   type: string
       *                   nullable: true
       *                   description: QR code data URL (present when session needs QR scan)
       *                 pairingCode:
       *                   type: string
       *                   nullable: true
       *                   description: 8-character pairing code (present after requestPairingCode call)
       */
      .get(this.routerPath('getAuthState'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<InstanceDto>({
            request: req,
            schema: null,
            ClassRef: InstanceDto,
            execute: (instance) => businessController.getAuthState(instance),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          console.error('Auth state error:', error);
          const errorResponse = createMetaErrorResponse(error, 'auth_state');
          return res.status(errorResponse.status).json(errorResponse);
        }
      })

      /**
       * @swagger
       * /business/logoutBrowser/{instanceName}:
       *   delete:
       *     tags: [Business]
       *     summary: Logout browser catalog session
       *     description: Kills the browser session and deletes persisted auth data. Next catalog fetch will require new QR scan or pairing code.
       *     security:
       *       - apikey: []
       *     parameters:
       *       - in: path
       *         name: instanceName
       *         required: true
       *         schema:
       *           type: string
       *     responses:
       *       200:
       *         description: Logged out
       */
      .delete(this.routerPath('logoutBrowser'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<InstanceDto>({
            request: req,
            schema: null,
            ClassRef: InstanceDto,
            execute: (instance) => businessController.logoutBrowser(instance),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          console.error('Logout browser error:', error);
          const errorResponse = createMetaErrorResponse(error, 'logout_browser');
          return res.status(errorResponse.status).json(errorResponse);
        }
      });
  }

  public readonly router: Router = Router();
}
