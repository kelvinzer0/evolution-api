import { getCatalogDto, getCollectionsDto } from '@api/dto/business.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { BrowserCatalogService } from '@api/integrations/channel/whatsapp/catalog-browser.service';
import { WAMonitoringService } from '@api/services/monitor.service';

export class BusinessController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  public async fetchCatalog({ instanceName }: InstanceDto, data: getCatalogDto) {
    return await this.waMonitor.waInstances[instanceName].fetchCatalog(instanceName, data);
  }

  public async fetchCollections({ instanceName }: InstanceDto, data: getCollectionsDto) {
    return await this.waMonitor.waInstances[instanceName].fetchCollections(instanceName, data);
  }

  /**
   * Request a phone-number pairing code for browser-based catalog session.
   * Returns 8-character code (e.g. "ABCD1234") the user enters on their phone
   * in WhatsApp → Linked Devices → Link with phone number instead.
   *
   * Phone format: international, digits only (e.g. "6285733556953" for Indonesia).
   */
  public async requestPairingCode({ instanceName }: InstanceDto, data: { phone: string }) {
    const svc = BrowserCatalogService.getInstance();
    if (!svc) {
      throw new Error('Browser catalog service is not initialized. Set CATALOG_BROWSER_ENABLED=true.');
    }
    const pairingCode = await svc.requestPairingCode(instanceName, data.phone);
    return {
      instance: instanceName,
      phone: data.phone,
      pairingCode,
      expiresIn: 60,
      instructions:
        'Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → ' +
        'Link with phone number instead → Enter the 8-character code',
    };
  }

  /**
   * Get current auth state of the browser session for an instance.
   * Used by the pairing UI to poll for: QR code, pairing code, or authenticated status.
   */
  public async getAuthState({ instanceName }: InstanceDto) {
    const svc = BrowserCatalogService.getInstance();
    if (!svc) {
      return {
        instance: instanceName,
        enabled: false,
        message: 'Browser catalog service is not initialized. Set CATALOG_BROWSER_ENABLED=true.',
      };
    }
    return {
      instance: instanceName,
      enabled: true,
      ...svc.getAuthState(instanceName),
    };
  }

  /**
   * Logout / delete the browser session for an instance.
   * User will need to re-scan QR or re-pair on next catalog fetch.
   */
  public async logoutBrowser({ instanceName }: InstanceDto) {
    const svc = BrowserCatalogService.getInstance();
    if (!svc) {
      throw new Error('Browser catalog service is not initialized.');
    }
    await svc.logout(instanceName);
    return {
      instance: instanceName,
      loggedOut: true,
      message: 'Browser session deleted. Next catalog fetch will require new auth.',
    };
  }
}
