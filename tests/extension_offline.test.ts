import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Loom Web Clipper Extension: Offline Queue & Sync Suite', () => {
  const extensionDir = path.resolve(__dirname, '../extension');

  it('Manifest V3 includes all required offline sync permissions', async () => {
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Loom Web Clipper');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('contextMenus');
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.action.default_popup).toBe('popup.html');

    // Verify all icon files exist
    for (const [size, iconRelPath] of Object.entries(manifest.icons)) {
      const iconPath = path.join(extensionDir, iconRelPath as string);
      const stat = await fs.stat(iconPath);
      expect(stat.size).toBeGreaterThan(0);
    }
  });

  it('Background Service Worker implements offline queueing and background sync alarms', async () => {
    const bgJs = await fs.readFile(path.join(extensionDir, 'background.js'), 'utf-8');

    // Queue storage & helpers
    expect(bgJs).toContain('STORAGE_QUEUE_KEY = \'offline_queue\'');
    expect(bgJs).toContain('SYNC_ALARM_NAME = \'loom-offline-sync\'');
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
    expect(popupJs).toContain('ENQUEUE_ITEM');
    expect(popupJs).toContain('TRIGGER_SYNC');
    expect(popupJs).toContain('QUEUE_SYNC_COMPLETE');
    expect(popupJs).toContain('Modo Offline');
    expect(popupJs).toContain('Guardar en Cola');
    expect(popupJs).toContain('Guardar en Loom');
  });
});
