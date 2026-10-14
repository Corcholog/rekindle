// Loom Web Clipper - Popup Script

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

  // 1. Check Loom server connection
  async function checkServer() {
    try {
      const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Loom Listo';
        submitBtn.disabled = false;
        return true;
      }
    } catch {
      // offline
    }
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Desconectado';
    return false;
  }

  await checkServer();

  // 2. Query active tab details
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

  // 3. Form Submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const url = urlInput.value.trim();
    const title = titleInput.value.trim();
    const selection = selectionInput.value.trim();

    if (!url) return;

    submitBtn.disabled = true;
    btnText.textContent = 'Enviando...';
    feedback.className = 'feedback';
    feedback.textContent = '';

    try {
      const res = await fetch(`${SERVER_URL}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          title,
          selection,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || data.error || 'Error al conectar con Loom');
      }

      feedback.className = 'feedback success';
      feedback.textContent = '✦ ¡Guardado en Loom! Analizando contra tus notas de Obsidian...';
      btnText.textContent = '✓ Guardado';

      setTimeout(() => {
        window.close();
      }, 1600);

    } catch (err) {
      console.error('Clipper submission error:', err);
      feedback.className = 'feedback error';
      feedback.textContent = `Error: ${err.message || 'No se pudo enviar a Loom'}`;
      submitBtn.disabled = false;
      btnText.textContent = 'Reintentar';
    }
  });
});
