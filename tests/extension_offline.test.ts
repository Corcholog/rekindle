import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Rekindle Clipper extension: offline queue and sync', () => {
  const extensionDir = path.resolve(__dirname, '../extension');

  it('Manifest V3 includes all required offline sync permissions', async () => {
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('__MSG_extName__');
    expect(manifest.default_locale).toBe('en');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('contextMenus');
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.action.default_popup).toBe('popup.html');

    // Verify all icon files exist
    for (const iconRelPath of Object.values(manifest.icons)) {
      const iconPath = path.join(extensionDir, iconRelPath as string);
      const stat = await fs.stat(iconPath);
      expect(stat.size).toBeGreaterThan(0);
    }
  });

  it('Background Service Worker implements offline queueing and background sync alarms', async () => {
    const bgJs = await fs.readFile(path.join(extensionDir, 'background.js'), 'utf-8');

    // Queue storage & helpers
    expect(bgJs).toContain('STORAGE_QUEUE_KEY = \'offline_queue\'');
    expect(bgJs).toContain('SYNC_ALARM_NAME = \'rekindle-offline-sync\'');
    // The pre-rename alarm is cleared on update; the queue key is unchanged, so queued clips survive
    expect(bgJs).toContain('chrome.alarms.clear(LEGACY_ALARM_NAME)');
    expect(bgJs).toContain('getOfflineQueue');
    expect(bgJs).toContain('setOfflineQueue');
    expect(bgJs).toContain('enqueueItem');
    expect(bgJs).toContain('tryFlushQueue');
    expect(bgJs).toContain('sendOrQueue');

    // Alarm & tab wakeup triggers
    expect(bgJs).toContain('chrome.alarms.onAlarm.addListener');
    expect(bgJs).toContain('chrome.tabs.onActivated.addListener');
    expect(bgJs).toContain('chrome.runtime.onStartup.addListener');
    expect(bgJs).toContain('chrome.runtime.onInstalled.addListener');
    expect(bgJs).toContain('chrome.contextMenus.onClicked.addListener');
    expect(bgJs).toContain('chrome.runtime.onMessage.addListener');

    // Visual feedback badge
    expect(bgJs).toContain('updateBadge');
    expect(bgJs).toContain('setBadgeBackgroundColor');
    expect(bgJs).toContain('#f59e0b'); // Amber offline/queued badge
    expect(bgJs).toContain('#10b981'); // Emerald success badge
  });

  it('Popup UI includes queue banner, offline mode indicator, and sync controls', async () => {
    const popupHtml = await fs.readFile(path.join(extensionDir, 'popup.html'), 'utf-8');

    expect(popupHtml).toContain('id="queue-banner"');
    expect(popupHtml).toContain('id="queue-msg"');
    expect(popupHtml).toContain('id="btn-sync-queue"');
    expect(popupHtml).toContain('id="offline-hint"');
    expect(popupHtml).toContain('id="status-dot"');
    expect(popupHtml).toContain('id="status-text"');
    expect(popupHtml).toContain('id="clip-form"');
    expect(popupHtml).toContain('id="btn-submit"');
  });

  it('Popup Script handles online/offline transitions, queueing, and auto-sync triggers', async () => {
    const popupJs = await fs.readFile(path.join(extensionDir, 'popup.js'), 'utf-8');

    expect(popupJs).toContain('SERVER_URL');
    expect(popupJs).toContain('checkServer');
    expect(popupJs).toContain('getLocalQueue');
    expect(popupJs).toContain('refreshQueueUI');
    expect(popupJs).toContain('enqueueDirectly');
    expect(popupJs).toContain('TRIGGER_SYNC');
    expect(popupJs).toContain('QUEUE_SYNC_COMPLETE');
    expect(popupJs).toContain("msg('offlineMode')");
    expect(popupJs).toContain("msg('saveToQueue')");
    expect(popupJs).toContain("msg('saveToRekindle')");
  });

  it('has English and Spanish strings for every message the extension uses', async () => {
    const locale = async (lang: string) => JSON.parse(await fs.readFile(path.join(extensionDir, '_locales', lang, 'messages.json'), 'utf-8'));
    const en = await locale('en');
    const es = await locale('es');
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());

    const sources = [
      await fs.readFile(path.join(extensionDir, 'popup.js'), 'utf-8'),
      await fs.readFile(path.join(extensionDir, 'background.js'), 'utf-8'),
      await fs.readFile(path.join(extensionDir, 'popup.html'), 'utf-8'),
      await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf-8'),
    ].join('\n');
    const used = new Set([
      ...[...sources.matchAll(/msg\('(\w+)'/g)].map(m => m[1]),
      ...[...sources.matchAll(/data-i18n(?:-placeholder|-title)?="(\w+)"/g)].map(m => m[1]),
      ...[...sources.matchAll(/__MSG_(\w+)__/g)].map(m => m[1]),
    ]);
    expect(used.size).toBeGreaterThan(20);
    for (const key of used) {
      expect(en[key], key).toBeDefined();
      expect(es[key], key).toBeDefined();
    }
    // A $1 placeholder must be declared, or Chrome prints it literally
    for (const entry of [...Object.values(en), ...Object.values(es)] as { message: string; placeholders?: object }[]) {
      if (entry.message.includes('$VALUE$')) expect(entry.placeholders).toBeDefined();
    }
  });
});
