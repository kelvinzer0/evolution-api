/**
 * NestJS module wiring for the browser-based catalog service.
 */

import { Module } from '@nestjs/common';

import { BrowserCatalogService } from './catalog-browser.service';
import { BrowserSessionStore } from './session-store.browser';

@Module({
  providers: [BrowserCatalogService, BrowserSessionStore],
  exports: [BrowserCatalogService, BrowserSessionStore],
})
export class CatalogBrowserModule {}
