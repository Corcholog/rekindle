// Loom Web Clipper - Popup Script (Manifest V3)
// Supports immediate saving and offline queueing with auto-sync

const SERVER_URL = 'http://localhost:3000';

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

  // --- Queue State Management ---

  async function getLocalQueue() {
    try {
      const data = await chrome.storage.local.get({ offline_queue: [] });
      return Array.isArray(data.offline_queue) ? data.offline_queue : [];
    } catch {
      return [];
    }
  }

  async function refreshQueueUI() {
    const queue = await getLocalQueue();
    if (queue.length > 0) {
      queueBanner.style.display = 'flex';
      if (isOnline) {
        queueMsg.textContent = `${queue.length} recorte(s) pendientes en cola`;
        btnSyncQueue.style.display = 'inline-block';
        btnSyncQueue.textContent = 'Sincronizar';
      } else {
        queueMsg.textContent = `${queue.length} en cola (esperando a Loom)`;
        btnSyncQueue.style.display = 'none';
      }
    } else {
      queueBanner.style.display = 'none';
    }
  }

  // --- Connectivity Check ---

  async function checkServer() {
    try {
      const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        isOnline = true;
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Loom Listo';
        btnText.textContent = 'Guardar en Loom';
        offlineHint.classList.remove('visible');
        await refreshQueueUI();
        return true;
      }
    } catch {
      // offline
    }

    isOnline = false;
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Modo Offline';
    btnText.textContent = 'Guardar en Cola';
    submitBtn.disabled = false;
    offlineHint.classList.add('visible');
    await refreshQueueUI();
    return false;
  }

  // Listen for sync notifications from service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'QUEUE_SYNC_COMPLETE') {
      refreshQueueUI();
    }
  });

  // Manual sync button
  btnSyncQueue.addEventListener('click', async () => {
    btnSyncQueue.disabled = true;
    btnSyncQueue.textContent = 'Enviando...';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' });
      if (res && res.success) {
        queueMsg.textContent = `✓ ${res.flushed} enviado(s) a Loom`;
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
    const selection = selectionInput.value.trim();

    if (!url) return;

    submitBtn.disabled = true;
    btnText.textContent = isOnline ? 'Enviando...' : 'Guardando...';
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
        feedback.textContent = '✦ ¡Guardado en Loom! Analizando contra tus notas de Obsidian...';
        btnText.textContent = '✓ Guardado';

        // Also trigger sync for any existing queue
        chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' }).catch(() => {});

        setTimeout(() => {
          window.close();
        }, 1600);
        return;

      } catch (err) {
        console.warn('Online send failed, falling back to offline queue:', err);
        // Fall through to offline queueing below
      }
    }

    // 2. Offline Path / Fallback Queueing
    try {
      await chrome.runtime.sendMessage({
        type: 'ENQUEUE_ITEM',
        payload
      });

      feedback.className = 'feedback warning';
      feedback.textContent = isOnline 
        ? '✦ Loom no respondió. Guardado en cola local: se enviará automáticamente.'
        : '✦ Guardado en cola local. Se enviará a Loom automáticamente cuando inicie la aplicación.';
      btnText.textContent = '✓ En cola';

      await refreshQueueUI();

      setTimeout(() => {
        window.close();
      }, 1800);

    } catch (err) {
      console.error('Failed to enqueue item:', err);
      feedback.className = 'feedback error';
      feedback.textContent = `Error al encolar: ${err.message || 'Error desconocido'}`;
      submitBtn.disabled = false;
      btnText.textContent = 'Reintentar';
    }
  });
});
