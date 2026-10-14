// Loom Web Clipper - Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(async () => {
  // Remove existing context menus before recreating to avoid duplicate ID errors
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'loom-clip-page',
      title: '✦ Enviar página actual a Loom',
      contexts: ['page']
    });

    chrome.contextMenus.create({
      id: 'loom-clip-selection',
      title: '✦ Guardar cita seleccionada en Loom',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'loom-clip-link',
      title: '✦ Enviar enlace a Loom',
      contexts: ['link']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let targetUrl = tab?.url || '';
  let targetTitle = tab?.title || '';
  let selection = '';

  if (info.menuItemId === 'loom-clip-link' && info.linkUrl) {
    targetUrl = info.linkUrl;
    targetTitle = '';
  } else if (info.menuItemId === 'loom-clip-selection') {
    selection = info.selectionText || '';
  }

  if (!targetUrl) return;

  await sendToLoom({
    url: targetUrl,
    title: targetTitle,
    selection
  });
});

async function sendToLoom(payload) {
  const SERVER_URL = 'http://localhost:3000';
  
  try {
    const res = await fetch(`${SERVER_URL}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }

    // Success badge feedback
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    await chrome.action.setBadgeText({ text: '✓' });
    
    // Clear badge after 3 seconds
    setTimeout(async () => {
      try {
        await chrome.action.setBadgeText({ text: '' });
      } catch {
        // SW may have gone to sleep
      }
    }, 3000);

  } catch (err) {
    console.error('[Loom Clipper SW] Failed sending to Loom:', err);
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    await chrome.action.setBadgeText({ text: '!' });

    setTimeout(async () => {
      try {
        await chrome.action.setBadgeText({ text: '' });
      } catch {
        // SW may have gone to sleep
      }
    }, 4000);
  }
}
