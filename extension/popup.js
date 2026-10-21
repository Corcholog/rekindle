// Rekindle reads at most this much of an article or selection (see background.js)
const MAX_SELECTION_CHARS = 50000;

// Rekindle Clipper - Popup Script (Manifest V3)
// Direct storage-backed offline queue with background sync

const SERVER_URL = 'http://localhost:3000';
const STORAGE_QUEUE_KEY = 'offline_queue';
const SYNC_ALARM_NAME = 'rekindle-offline-sync';

// Strings come from _locales/<browser language>/messages.json
const msg = (key, value) => chrome.i18n.getMessage(key, value === undefined ? undefined : [String(value)]);
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = msg(el.dataset.i18n); });
document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = msg(el.dataset.i18nPlaceholder); });
document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = msg(el.dataset.i18nTitle); });

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const titleInput = document.getElementById('clip-title');
  const urlInput = document.getElementById('clip-url');
  const selectionInput = document.getElementById('clip-selection');
  const form = document.getElementById('clip-form');
  const submitBtn = document.getElementById('btn-submit');
  const btnText = document.getElementById('btn-text');
  const feedback = document.getElementById('feedback');
  const queueBanner = document.getElementById('queue-banner');
  const queueMsg = document.getElementById('queue-msg');
  const btnSyncQueue = document.getElementById('btn-sync-queue');
  const offlineHint = document.getElementById('offline-hint');

  let isOnline = false;

  // --- Queue State Management (Direct chrome.storage access) ---

  async function getLocalQueue() {
    try {
      const data = await chrome.storage.local.get({ [STORAGE_QUEUE_KEY]: [] });
      return Array.isArray(data[STORAGE_QUEUE_KEY]) ? data[STORAGE_QUEUE_KEY] : [];
    } catch {
      return [];
    }
  }

  async function updateBadgeDirectly(queueLength) {
    try {
      if (queueLength > 0) {
        await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
        await chrome.action.setBadgeText({ text: String(queueLength) });
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
    } catch {
      // Ignored if action API restricted
    }
  }

  async function refreshQueueUI() {
    const queue = await getLocalQueue();
    if (queue.length > 0) {
      queueBanner.style.display = 'flex';
      if (isOnline) {
        queueMsg.textContent = msg('queuePending', queue.length);
        btnSyncQueue.style.display = 'inline-block';
        btnSyncQueue.textContent = msg('sync');
      } else {
        queueMsg.textContent = msg('queueWaiting', queue.length);
        btnSyncQueue.style.display = 'none';
      }
    } else {
      queueBanner.style.display = 'none';
    }
    await updateBadgeDirectly(queue.length);
  }

  async function enqueueDirectly(item) {
    const queue = await getLocalQueue();
    
    // Avoid duplicate rapid enqueues
    const isDuplicate = queue.some(
      q => q.url === item.url && q.selection === (item.selection || '') && (Date.now() - q.timestamp < 30000)
    );

    if (!isDuplicate) {
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
      await chrome.storage.local.set({ [STORAGE_QUEUE_KEY]: queue });
    }

    await updateBadgeDirectly(queue.length);

    // Register sync alarm directly from popup
    try {
      await chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
    } catch {}

    // Wake up background worker if awake, but never fail if it's inactive
    try {
      chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' }).catch(() => {});
    } catch {}

    return queue.length;
  }

  async function flushDirectly() {
    const queue = await getLocalQueue();
    if (queue.length === 0) {
      await updateBadgeDirectly(0);
      return { success: true, flushed: 0, remaining: 0 };
    }

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
          if ((item.retries || 0) < 3) {
            remaining.push({ ...item, retries: (item.retries || 0) + 1 });
          }
        } else {
          remaining.push(item);
          break;
        }
      } catch {
        remaining.push(item);
        break;
      }
    }

    await chrome.storage.local.set({ [STORAGE_QUEUE_KEY]: remaining });

    if (remaining.length === 0) {
      try {
        await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
        await chrome.action.setBadgeText({ text: '✓' });
        setTimeout(async () => {
          try {
            const latest = await getLocalQueue();
            if (latest.length === 0) await chrome.action.setBadgeText({ text: '' });
          } catch {}
        }, 3000);
      } catch {}
    } else {
      await updateBadgeDirectly(remaining.length);
    }

    return { success: true, flushed: flushedCount, remaining: remaining.length };
  }

  // --- Connectivity Check ---

  async function checkServer() {
    try {
      const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        isOnline = true;
        statusDot.className = 'status-dot online';
        statusText.textContent = msg('ready');
        btnText.textContent = msg('saveToRekindle');
        offlineHint.classList.remove('visible');
        await refreshQueueUI();
        return true;
      }
    } catch {
      // offline
    }

    isOnline = false;
    statusDot.className = 'status-dot offline';
    statusText.textContent = msg('offlineMode');
    btnText.textContent = msg('saveToQueue');
    submitBtn.disabled = false;
    offlineHint.classList.add('visible');
    await refreshQueueUI();
    return false;
  }

  // Listen for sync notifications from service worker
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'QUEUE_SYNC_COMPLETE') {
        refreshQueueUI();
      }
    });
  } catch {}

  // Manual sync button
  btnSyncQueue.addEventListener('click', async () => {
    btnSyncQueue.disabled = true;
    btnSyncQueue.textContent = msg('sending');
    try {
      const res = await flushDirectly();
      if (res && res.success) {
        queueMsg.textContent = msg('sent', res.flushed);
        setTimeout(async () => {
          await refreshQueueUI();
        }, 1500);
      } else {
        await refreshQueueUI();
      }
    } catch (err) {
      console.warn('Sync trigger error:', err);
      await refreshQueueUI();
    } finally {
      btnSyncQueue.disabled = false;
    }
  });

  // Initial connectivity check
  await checkServer();

  // --- Query Active Tab Data ---

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      titleInput.value = tab.title || '';
      urlInput.value = tab.url || '';

      // Try to read user text selection from active tab
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.getSelection ? window.getSelection().toString() : ''
          });

          if (results && results[0] && results[0].result) {
            selectionInput.value = results[0].result.trim();
          }
        } catch {
          // Ignore scripting restrictions on protected pages
        }
      }
    }
  } catch (err) {
    console.warn('Could not query active tab:', err);
  }

  // --- Form Submission Handler ---

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const url = urlInput.value.trim();
    const title = titleInput.value.trim();
    const selection = selectionInput.value.trim().slice(0, MAX_SELECTION_CHARS);

    if (!url) return;

    submitBtn.disabled = true;
    btnText.textContent = isOnline ? msg('sending') : msg('saving');
    feedback.className = 'feedback';
    feedback.textContent = '';

    const payload = { url, title, selection };

    if (isOnline) {
      // 1. Online Path: Attempt direct send
      try {
        const res = await fetch(`${SERVER_URL}/api/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(4000)
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.message || data.error || `Server HTTP ${res.status}`);
        }

        feedback.className = 'feedback success';
        feedback.textContent = msg('savedOnline');
        btnText.textContent = msg('saved');

        // Also flush any items that were queued previously
        flushDirectly().catch(() => {});

        setTimeout(() => {
          window.close();
        }, 1600);
        return;

      } catch (err) {
        console.warn('Online send failed, falling back to offline queue:', err);
        // Fall through to offline queueing below
      }
    }

    // 2. Offline Path / Fallback Queueing (Direct storage access, never fails on sleeping SW)
    try {
      const newQueueLength = await enqueueDirectly(payload);

      feedback.className = 'feedback warning';
      feedback.textContent = isOnline 
        ? msg('queuedNoResponse')
        : msg('queuedOffline');
      btnText.textContent = msg('queued');

      await refreshQueueUI();

      setTimeout(() => {
        window.close();
      }, 1800);

    } catch (err) {
      console.error('Failed to enqueue item:', err);
      feedback.className = 'feedback error';
      feedback.textContent = msg('queueError', err.message || msg('unknownError'));
      submitBtn.disabled = false;
      btnText.textContent = msg('retry');
    }
  });
});
