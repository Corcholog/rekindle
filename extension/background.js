// Rekindle reads at most this much of an article or selection; longer text is cut here, so a
// huge selection never makes the server reject (and the queue drop) a clip
const MAX_SELECTION_CHARS = 50000;

// Rekindle Clipper - Background Service Worker (Manifest V3)
// Provides offline queueing with auto-sync when the Rekindle server reconnects

const SERVER_URL = 'http://localhost:3000';
const SYNC_ALARM_NAME = 'rekindle-offline-sync';
// Alarm name used before the rename (Loom); cleared on update so it stops firing
const LEGACY_ALARM_NAME = 'loom-offline-sync';
const msg = (key, value) => chrome.i18n.getMessage(key, value === undefined ? undefined : [String(value)]);
const STORAGE_QUEUE_KEY = 'offline_queue';

// --- Queue & Badge Helpers ---

async function getOfflineQueue() {
  const result = await chrome.storage.local.get({ [STORAGE_QUEUE_KEY]: [] });
  return Array.isArray(result[STORAGE_QUEUE_KEY]) ? result[STORAGE_QUEUE_KEY] : [];
}

async function setOfflineQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_QUEUE_KEY]: queue });
  await updateBadge(queue.length);
}

async function updateBadge(queueLength) {
  try {
    if (queueLength > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Amber warning/offline
      await chrome.action.setBadgeText({ text: String(queueLength) });
      await chrome.action.setTitle({
        title: msg('badgeQueued', queueLength)
      });
    } else {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: msg('extName') });
    }
  } catch (err) {
    console.warn('[Rekindle Clipper SW] Badge update error:', err);
  }
}

async function enqueueItem(item) {
  const queue = await getOfflineQueue();
  
  // Avoid duplicate clicks within short time frame
  const isDuplicate = queue.some(
    q => q.url === item.url && q.selection === (item.selection || '') && (Date.now() - q.timestamp < 30000)
  );

  if (isDuplicate) {
    console.log('[Rekindle Clipper SW] Skipping duplicate enqueue for:', item.url);
    return queue.length;
  }

  const newItem = {
    id: typeof crypto.randomUUID === 'function' 
      ? crypto.randomUUID() 
      : `clip_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    url: item.url,
    title: item.title || '',
    selection: (item.selection || '').slice(0, MAX_SELECTION_CHARS),
    timestamp: Date.now(),
    retries: 0
  };

  queue.push(newItem);
  await setOfflineQueue(queue);

  // Ensure periodic background sync alarm is active
  await chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });

  // Attempt immediate flush in case server is ready
  tryFlushQueue().catch(() => {});

  return queue.length;
}

// --- Queue Flush / Sync Engine ---

async function tryFlushQueue() {
  const queue = await getOfflineQueue();
  if (queue.length === 0) {
    await updateBadge(0);
    await chrome.alarms.clear(SYNC_ALARM_NAME);
    return { success: true, count: 0, flushed: 0 };
  }

  // 1. Check Rekindle server connectivity
  let isOnline = false;
  try {
    const healthRes = await fetch(`${SERVER_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2500)
    });
    isOnline = healthRes.ok;
  } catch {
    isOnline = false;
  }

  if (!isOnline) {
    // Rekindle is still down; keep queue and notify badge
    await updateBadge(queue.length);
    return { success: false, reason: 'offline', remaining: queue.length };
  }

  // 2. Rekindle is reachable: process queue items sequentially
  const remaining = [];
  let flushedCount = 0;

  for (const item of queue) {
    try {
      const res = await fetch(`${SERVER_URL}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: item.url,
          title: item.title,
          selection: item.selection
        }),
        signal: AbortSignal.timeout(6000)
      });

      if (res.ok) {
        flushedCount++;
      } else if (res.status >= 400 && res.status < 500) {
        // Bad request / invalid input: increment retry or discard if corrupted
        if ((item.retries || 0) < 3) {
          remaining.push({ ...item, retries: (item.retries || 0) + 1 });
        } else {
          console.warn('[Rekindle Clipper SW] Dropping permanently failed item:', item.url);
        }
      } else {
        // Server 5xx or temporary failure: retain item and stop current batch
        remaining.push(item);
        break;
      }
    } catch (err) {
      console.warn('[Rekindle Clipper SW] Network error sending queued item:', err);
      remaining.push(item);
      break;
    }
  }

  await setOfflineQueue(remaining);

  if (remaining.length === 0) {
    // All items synced! Show temporary green badge
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.alarms.clear(SYNC_ALARM_NAME);

    // Clear after 3.5s
    setTimeout(async () => {
      try {
        const latest = await getOfflineQueue();
        if (latest.length === 0) {
          await chrome.action.setBadgeText({ text: '' });
        }
      } catch {
        // SW may have terminated
      }
    }, 3500);
  } else {
    await updateBadge(remaining.length);
  }

  // Notify any active popup of sync progress
  try {
    chrome.runtime.sendMessage({
      type: 'QUEUE_SYNC_COMPLETE',
      flushed: flushedCount,
      remaining: remaining.length
    }).catch(() => {});
  } catch {
    // No popup listener active
  }

  return { success: true, flushed: flushedCount, remaining: remaining.length };
}

// --- Context Menu Send or Queue ---

async function sendOrQueue(payload) {
  try {
    const res = await fetch(`${SERVER_URL}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000)
    });

    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }

    // Direct success feedback
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    await chrome.action.setBadgeText({ text: '✓' });

    setTimeout(async () => {
      try {
        const queue = await getOfflineQueue();
        if (queue.length > 0) {
          await updateBadge(queue.length);
        } else {
          await chrome.action.setBadgeText({ text: '' });
        }
      } catch {}
    }, 3000);

  } catch (err) {
    console.warn('[Rekindle Clipper SW] Rekindle server offline, enqueueing locally:', err.message);
    const count = await enqueueItem(payload);
    console.log(`[Rekindle Clipper SW] Item queued for future sync. Total in queue: ${count}`);
  }
}

// --- Top-Level Lifecycle & Event Listeners ---

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.clear(LEGACY_ALARM_NAME);
  // Re-create context menus
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'rekindle-clip-page',
      title: msg('menuPage'),
      contexts: ['page']
    });

    chrome.contextMenus.create({
      id: 'rekindle-clip-selection',
      title: msg('menuSelection'),
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'rekindle-clip-link',
      title: msg('menuLink'),
      contexts: ['link']
    });
  });

  const queue = await getOfflineQueue();
  await updateBadge(queue.length);
  if (queue.length > 0) {
    await chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
    await tryFlushQueue();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const queue = await getOfflineQueue();
  await updateBadge(queue.length);
  if (queue.length > 0) {
    await chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
    await tryFlushQueue();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    await tryFlushQueue();
  }
});

// Auto-sync attempt on user tab switch/navigation if queue is waiting
chrome.tabs.onActivated.addListener(async () => {
  const queue = await getOfflineQueue();
  if (queue.length > 0) {
    await tryFlushQueue();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let targetUrl = tab?.url || '';
  let targetTitle = tab?.title || '';
  let selection = '';

  if (info.menuItemId === 'rekindle-clip-link' && info.linkUrl) {
    targetUrl = info.linkUrl;
    targetTitle = '';
  } else if (info.menuItemId === 'rekindle-clip-selection') {
    selection = (info.selectionText || '').slice(0, MAX_SELECTION_CHARS);
  }

  if (!targetUrl) return;

  await sendOrQueue({
    url: targetUrl,
    title: targetTitle,
    selection
  });
});

// Communication with popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'GET_QUEUE_STATE') {
      const queue = await getOfflineQueue();
      sendResponse({ queue, count: queue.length });
    } else if (message.type === 'ENQUEUE_ITEM') {
      const count = await enqueueItem(message.payload);
      sendResponse({ success: true, count });
    } else if (message.type === 'TRIGGER_SYNC') {
      const result = await tryFlushQueue();
      sendResponse(result);
    }
  })();
  return true; // Keep message port open for async response
});
