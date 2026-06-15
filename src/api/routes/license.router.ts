// Public license endpoints — must NOT be behind auth, must work before activation.
// Mirrors evolution-go LicenseRoutes() in pkg/core/runtime.go.

import { Logger } from '@config/logger.config';
import { Request, Response, Router } from 'express';

import { activateWithCode, initRegistration, publicSnapshot, RuntimeContext } from '../../licensing/runtime';
import { readErrorMessage } from '../../licensing/transport';

const logger = new Logger('LicenseRouter');

export function buildLicenseRouter(rc: RuntimeContext): Router {
  const router = Router();

  // GET /license/status — light-weight status check, used by the manager UI on boot.
  router.get('/status', (_req: Request, res: Response) => {
    res.status(200).json(publicSnapshot(rc));
  });

  // GET /license/register?redirect_uri= — initiates registration, returns register_url.
  router.get('/register', async (req: Request, res: Response) => {
    if (rc.isActive()) {
      return res.status(200).json({ status: 'active', message: 'License is already active' });
    }

    if (rc.registerUrl) {
      return res.status(200).json({ status: 'pending', register_url: rc.registerUrl });
    }

    try {
      const redirectUri = (req.query.redirect_uri as string) || undefined;
      const url = await initRegistration(rc, redirectUri);
      logger.info(`Registration URL issued: ${url}`);
      return res.status(200).json({ status: 'pending', register_url: url });
    } catch (err) {
      return res.status(502).json({
        error: 'Failed to contact licensing server',
        details: readErrorMessage(err),
      });
    }
  });

  // GET /license/activate?code= — exchanges authorization code for api_key and activates.
  router.get('/activate', async (req: Request, res: Response) => {
    if (rc.isActive()) {
      return res.status(200).json({ status: 'active', message: 'License is already active' });
    }

    const code = (req.query.code as string) || '';
    if (!code) {
      return res.status(400).json({
        error: 'Missing code parameter',
        message: 'Provide ?code=AUTHORIZATION_CODE from the registration callback.',
      });
    }

    try {
      await activateWithCode(rc, code);
      return res.status(200).json({ status: 'active', message: 'License activated successfully!' });
    } catch (err) {
      const message = readErrorMessage(err);
      // Mirror Go: distinguish bad-request vs server error.
      const status = /invalid|expired/i.test(message) ? 400 : 502;
      return res.status(status).json({
        error: status === 400 ? 'Invalid or expired code' : 'Activation failed',
        details: message,
      });
    }
  });

  return router;
}
