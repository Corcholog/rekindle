// ==========================================================================
// Loom — Client Application Logic (Phase 7 Web UI)
// ==========================================================================

// State Management
const state = {
  currentView: 'inbox', // 'inbox' | 'triage' | 'settings'
  selectedProjectId: null, // null means "all projects"
  selectedSuggestionStatus: 'active', // 'active' | 'pending' | 'tentative' | 'accepted' | 'discarded'
  inFlightPollingTimer: null,
  projects: [],
  contents: [],
  suggestions: [],
  openDetails: new Set(),
  loadedReasonings: new Map(),
  feedbackDrafts: new Map(),
  renderedSuggestionsSignature: '',
  vaultStatus: null,
  synergies: [],
};

// Action Type Labels in Spanish (User Domain)
const ACTION_LABELS = {
  evidence_citation: 'Cita de Evidencia',
  counter_argument: 'Contraargumento',
  unblocker: 'Desbloqueo',
  narrative_bridge: 'Puente Narrativo',
  other: 'Otro',
};

// Status Labels in Spanish
const STATUS_LABELS = {
  ready: 'Listo',
  pending: 'Pendiente',
  extracting: 'Extrayendo',
  summarizing: 'Resumiendo',
  embedding: 'Indexando',
  failed: 'Falló',
};

// DOM Elements
const elements = {
  // Tabs & Views
  tabInbox: document.getElementById('tab-inbox'),
  tabTriage: document.getElementById('tab-triage'),
  tabSettings: document.getElementById('tab-settings'),
  viewInbox: document.getElementById('view-inbox'),
  viewTriage: document.getElementById('view-triage'),
  viewSettings: document.getElementById('view-settings'),
  inboxActiveCount: document.getElementById('inbox-active-count'),
  triagePendingBadge: document.getElementById('triage-pending-badge'),
  liveIndicator: document.getElementById('live-indicator'),
  liveText: document.getElementById('live-text'),

  // Vault Warning Banner
  vaultWarningBanner: document.getElementById('vault-warning-banner'),
  vaultBannerText: document.getElementById('vault-banner-text'),
  btnBannerGoSettings: document.getElementById('btn-banner-go-settings'),

  // Inbox
  ingestForm: document.getElementById('ingest-form'),
  urlInput: document.getElementById('url-input'),
  btnSubmitUrl: document.getElementById('btn-submit-url'),
  ingestSpinner: document.getElementById('ingest-spinner'),
  ingestFormError: document.getElementById('ingest-form-error'),
  contentsList: document.getElementById('contents-list'),
  feedCount: document.getElementById('feed-count'),
  filterStatus: document.getElementById('filter-status'),
  btnRefreshFeed: document.getElementById('btn-refresh-feed'),

  // Triage
  projectsList: document.getElementById('projects-list'),
  projectsCount: document.getElementById('projects-count'),
  selectedProjectTitle: document.getElementById('selected-project-title'),
  selectedProjectThesis: document.getElementById('selected-project-thesis'),
  tabStatusActive: document.getElementById('tab-status-active'),
  tabStatusPending: document.getElementById('tab-status-pending'),
  tabStatusAccepted: document.getElementById('tab-status-accepted'),
  tabStatusTentative: document.getElementById('tab-status-tentative'),
  tabStatusDiscarded: document.getElementById('tab-status-discarded'),
  badgeActive: document.getElementById('badge-active'),
  badgePending: document.getElementById('badge-pending'),
  badgeAccepted: document.getElementById('badge-accepted'),
  badgeTentative: document.getElementById('badge-tentative'),
  badgeDiscarded: document.getElementById('badge-discarded'),
  suggestionsList: document.getElementById('suggestions-list'),

  // Settings
  vaultSettingsForm: document.getElementById('vault-settings-form'),
  vaultPathInput: document.getElementById('vault-path-input'),
  btnSaveVault: document.getElementById('btn-save-vault'),
  vaultSaveSpinner: document.getElementById('vault-save-spinner'),
  vaultFormFeedback: document.getElementById('vault-form-feedback'),
  settingsStatusPill: document.getElementById('settings-status-pill'),
  settingsStatusLabel: document.getElementById('settings-status-label'),
  infoActivePath: document.getElementById('info-active-path'),
  infoWatcherStatus: document.getElementById('info-watcher-status'),
  infoProjectsFolder: document.getElementById('info-projects-folder'),
  btnRescanVault: document.getElementById('btn-rescan-vault'),
  settingsProjectsCount: document.getElementById('settings-projects-count'),
  settingsProjectsWrapper: document.getElementById('settings-projects-wrapper'),

  // Project Hero Actions & Synthesis (Feature 4)
  projectHeroActions: document.getElementById('project-hero-actions'),
  btnSynthesizeProject: document.getElementById('btn-synthesize-project'),
  btnSynthesizeText: document.getElementById('btn-synthesize-text'),
  synthesizeSpinner: document.getElementById('synthesize-spinner'),

  // Synthesis Result Modal (Feature 4)
  synthesisResultModal: document.getElementById('synthesis-result-modal'),
  synthesisModalTitle: document.getElementById('synthesis-modal-title'),
  synthesisModalBody: document.getElementById('synthesis-modal-body'),
  btnCloseSynthesisModal: document.getElementById('btn-close-synthesis-modal'),

  // Cross-Project Synergies (Feature 5)
  synergiesSection: document.getElementById('synergies-section'),
  synergiesCountBadge: document.getElementById('synergies-count-badge'),
  synergiesGrid: document.getElementById('synergies-grid'),
  btnRefreshSynergies: document.getElementById('btn-refresh-synergies'),
  synergyBridgeModal: document.getElementById('synergy-bridge-modal'),
  synergyModalTitle: document.getElementById('synergy-modal-title'),
  synergyModalBody: document.getElementById('synergy-modal-body'),
  btnCloseSynergyModal: document.getElementById('btn-close-synergy-modal'),

  // Modal & Toast
  contentDetailModal: document.getElementById('content-detail-modal'),
  modalContentTitle: document.getElementById('modal-content-title'),
  modalContentBody: document.getElementById('modal-content-body'),
  btnCloseModal: document.getElementById('btn-close-modal'),
  toastContainer: document.getElementById('toast-container'),
};

// ==========================================================================
// Initialization
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupIngestionForm();
  setupBookmarkletAndClipper();
  setupLibrarySearchAndAsk();
  setupTriageStatusTabs();
  setupSettingsView();
  setupModalEvents();
  setupSynthesisAction();
  setupSynergies();
  setupSystemStatusPoller();

  // Initial Data Load
  loadVaultSettings();
  loadContents();
  loadProjects();
  loadSuggestions();
  loadSynergies();

  handleQuickIngestUrlParam();
});

// ==========================================================================
// Toast Notification System
// ==========================================================================

export function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'status');

  const iconSvg = type === 'success' 
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
    : type === 'error'
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

  toast.innerHTML = `
    <span class="toast-icon">${iconSvg}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

// ==========================================================================
// System Status & Background Poller
// ==========================================================================

let wasProcessing = false;
let isStatusPollerInFlight = false;

function setupSystemStatusPoller() {
  const checkStatus = async () => {
    if (document.hidden) return;
    if (isStatusPollerInFlight) return;
    isStatusPollerInFlight = true;
    try {
      const res = await fetch('/api/system/status');
      if (!res.ok) return;
      const data = await res.json();
      const headerStatus = elements.liveIndicator?.parentElement;

      if (data.isProcessing) {
        if (elements.liveIndicator) {
          elements.liveIndicator.className = 'status-indicator processing';
          elements.liveIndicator.title = data.message || 'Procesando en segundo plano';
        }
        if (elements.liveText) {
          elements.liveText.textContent = data.message || 'Procesando...';
        }
        if (headerStatus) {
          headerStatus.classList.add('processing');
        }
        wasProcessing = true;
      } else {
        if (elements.liveIndicator) {
          elements.liveIndicator.className = 'status-indicator live';
          elements.liveIndicator.title = 'Conexión en vivo activa';
        }
        if (elements.liveText) {
          elements.liveText.textContent = 'Conectado';
        }
        if (headerStatus) {
          headerStatus.classList.remove('processing');
        }

        // If background tasks just finished, automatically refresh lists
        if (wasProcessing) {
          wasProcessing = false;
          await loadContents();
          await loadProjects();
          await loadSuggestions();
        }
      }
    } catch {
      // Ignore background network transient errors
    } finally {
      isStatusPollerInFlight = false;
    }
  };

  checkStatus();
  setInterval(checkStatus, 2500);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkStatus();
      if (state.inFlightPollingTimer) {
        loadContents();
      }
    }
  });
}

// ==========================================================================
// Navigation & Views
// ==========================================================================

function setupNavigation() {
  elements.tabInbox.addEventListener('click', () => switchView('inbox'));
  elements.tabTriage.addEventListener('click', () => switchView('triage'));
  if (elements.tabSettings) {
    elements.tabSettings.addEventListener('click', () => switchView('settings'));
  }
  if (elements.btnBannerGoSettings) {
    elements.btnBannerGoSettings.addEventListener('click', () => switchView('settings'));
  }
}

function switchView(viewName) {
  state.currentView = viewName;

  elements.tabInbox.classList.toggle('active', viewName === 'inbox');
  elements.tabTriage.classList.toggle('active', viewName === 'triage');
  if (elements.tabSettings) {
    elements.tabSettings.classList.toggle('active', viewName === 'settings');
  }

  elements.viewInbox.classList.toggle('active', viewName === 'inbox');
  elements.viewTriage.classList.toggle('active', viewName === 'triage');
  if (elements.viewSettings) {
    elements.viewSettings.classList.toggle('active', viewName === 'settings');
  }

  if (viewName === 'inbox') {
    loadContents();
  } else if (viewName === 'triage') {
    loadProjects();
    loadSuggestions();
  } else if (viewName === 'settings') {
    loadVaultSettings();
  }
}

// ==========================================================================
// View A: Consumo de Contenido (Content Consumption) Logic
// ==========================================================================

function setupIngestionForm() {
  elements.ingestForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = elements.urlInput.value.trim();
    if (!url) return;

    elements.ingestFormError.style.display = 'none';
    elements.btnSubmitUrl.disabled = true;
    elements.ingestSpinner.style.display = 'inline-block';

    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Error al encolar la URL');
      }

      elements.urlInput.value = '';
      showToast('Enlace enviado para análisis y extracción.', 'success');
      loadContents();
      loadProjects();
    } catch (err) {
      elements.ingestFormError.textContent = err.message;
      elements.ingestFormError.style.display = 'block';
      showToast(err.message, 'error');
    } finally {
      elements.btnSubmitUrl.disabled = false;
      elements.ingestSpinner.style.display = 'none';
    }
  });

  elements.filterStatus.addEventListener('change', () => loadContents());
  elements.btnRefreshFeed.addEventListener('click', () => loadContents());
}

function setupBookmarkletAndClipper() {
  const bookmarkletBtn = document.getElementById('bookmarklet-btn');
  const btnCopyBookmarklet = document.getElementById('btn-copy-bookmarklet');
  const btnShowExtensionGuide = document.getElementById('btn-show-extension-guide');
  const extensionGuideModal = document.getElementById('extension-guide-modal');
  const btnCloseExtensionModal = document.getElementById('btn-close-extension-modal');

  const origin = window.location.origin;
  const bookmarkletCode = `javascript:(function(){const u=location.href,t=document.title,s=window.getSelection?window.getSelection().toString():'',serverUrl='${origin}',id='__loom_clipper_hud';let h=document.getElementById(id);if(h)h.remove();h=document.createElement('div');h.id=id;h.style.cssText='position:fixed;top:20px;right:20px;z-index:2147483647;background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:10px;padding:12px 18px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.5);display:flex;align-items:center;gap:10px;transition:all 0.3s ease;';h.innerHTML='<span style="font-size:16px;">⏳</span> Enlazando con Loom...';document.body.appendChild(h);fetch(serverUrl+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u,title:t,selection:s})}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(()=>{h.style.borderColor='#10b981';h.style.background='#064e3b';h.innerHTML='<span style="color:#34d399;font-size:16px;">✦</span> <strong>¡Enviado a Loom!</strong> Analizando notas...';setTimeout(()=>{h.style.opacity='0';setTimeout(()=>h.remove(),400);},2500);}).catch(()=>{h.remove();window.open(serverUrl+'/?quick_ingest='+encodeURIComponent(u)+'&title='+encodeURIComponent(t),'LoomClip','width=560,height=420');});})();`;

  if (bookmarkletBtn) {
    bookmarkletBtn.setAttribute('href', bookmarkletCode);
  }

  if (btnCopyBookmarklet) {
    btnCopyBookmarklet.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(bookmarkletCode);
        showToast('¡Código del Bookmarklet copiado al portapapeles!', 'success');
      } catch {
        prompt('Copia el siguiente código para tu marcador:', bookmarkletCode);
      }
    });
  }

  if (btnShowExtensionGuide && extensionGuideModal) {
    btnShowExtensionGuide.addEventListener('click', () => {
      extensionGuideModal.showModal();
    });
  }

  if (btnCloseExtensionModal && extensionGuideModal) {
    btnCloseExtensionModal.addEventListener('click', () => {
      extensionGuideModal.close();
    });
  }
}

function handleQuickIngestUrlParam() {
  const params = new URLSearchParams(window.location.search);
  const quickUrl = params.get('quick_ingest');
  if (quickUrl) {
    elements.urlInput.value = quickUrl;
    showToast('✦ Enlace recibido desde el navegador. Analizando...', 'info');
    elements.ingestForm.dispatchEvent(new Event('submit', { cancelable: true }));
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

function setupLibrarySearchAndAsk() {
  const form = document.getElementById('library-query-form');
  const input = document.getElementById('library-query-input');
  const btnSubmit = document.getElementById('btn-submit-library-query');
  const btnText = document.getElementById('library-btn-text');
  const spinner = document.getElementById('library-spinner');
  const resultsBox = document.getElementById('library-results-box');
  const btnModeSearch = document.getElementById('btn-mode-search');
  const btnModeAsk = document.getElementById('btn-mode-ask');

  if (!form || !input || !resultsBox) return;

  let currentMode = 'search'; // 'search' | 'ask'

  btnModeSearch?.addEventListener('click', () => {
    currentMode = 'search';
    btnModeSearch.classList.add('active');
    btnModeAsk?.classList.remove('active');
    btnText.textContent = 'Buscar en Biblioteca';
    input.placeholder = '¿Qué métodos de diseño de agentes o argumentos tenemos?...';
  });

  btnModeAsk?.addEventListener('click', () => {
    currentMode = 'ask';
    btnModeAsk.classList.add('active');
    btnModeSearch?.classList.remove('active');
    btnText.textContent = 'Preguntar (Sintetizar)';
    input.placeholder = 'Formula una pregunta para sintetizar con citas de tu biblioteca...';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    btnSubmit.disabled = true;
    spinner.style.display = 'inline-block';
    resultsBox.style.display = 'block';
    resultsBox.innerHTML = `
      <div class="empty-state">
        <span class="spinner"></span>
        <p>${currentMode === 'ask' ? 'Consultando y sintetizando con tus fuentes...' : 'Buscando afinidad semántica en tus lecturas...'}</p>
      </div>
    `;

    try {
      if (currentMode === 'search') {
        const res = await fetch(`/api/library/search?q=${encodeURIComponent(query)}&limit=8`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Error en la búsqueda');

        if (!data.results || data.results.length === 0) {
          resultsBox.innerHTML = `
            <div class="empty-state">
              <p>No se encontraron contenidos coincidentes en tu biblioteca.</p>
            </div>
          `;
          return;
        }

        resultsBox.innerHTML = `
          <div class="feed-header" style="padding-bottom: 0.5rem;">
            <span class="feed-title" style="font-size: 1.05rem;">Resultados Semánticos (${data.total})</span>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-clear-library-results">Cerrar</button>
          </div>
          <div class="items-list">
            ${data.results.map(r => `
              <div class="feed-item" data-id="${r.id}">
                <div class="feed-item-header">
                  <span class="domain-tag">${escapeHtml(r.channelOrDomain || 'Web')}</span>
                  <span class="badge badge-accent">${Math.round(r.similarityScore * 100)}% afinidad</span>
                </div>
                <h4 class="feed-item-title">${escapeHtml(r.title || r.uri)}</h4>
                <p class="feed-item-summary">${escapeHtml((r.summary || '').substring(0, 200))}...</p>
                <div class="feed-item-meta">
                  <a href="${escapeHtml(r.uri)}" target="_blank" rel="noopener" class="source-link">Ver enlace original ↗</a>
                  <button type="button" class="btn btn-secondary btn-sm btn-view-library-detail" data-id="${r.id}">Ver Ficha</button>
                </div>
              </div>
            `).join('')}
          </div>
        `;

        document.getElementById('btn-clear-library-results')?.addEventListener('click', () => {
          resultsBox.style.display = 'none';
          resultsBox.innerHTML = '';
        });

        resultsBox.querySelectorAll('.btn-view-library-detail').forEach(btn => {
          btn.addEventListener('click', () => {
            const cid = btn.getAttribute('data-id');
            const found = state.contents.find(c => c.id === cid) || data.results.find(c => c.id === cid);
            if (found) openContentDetailModal(found);
          });
        });

      } else {
        // Mode === 'ask' (RAG Synthesis)
        const res = await fetch('/api/library/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Error al sintetizar respuesta');

        let formattedAnswer = escapeHtml(data.answer);
        formattedAnswer = formattedAnswer.replace(/\[(\d+)\]/g, (match, num) => {
          return `<a href="#source-${num}" class="ask-source-badge" title="Ver Fuente [${num}]">[${num}]</a>`;
        });

        const insightsHtml = (data.keyInsights && data.keyInsights.length > 0)
          ? `
            <div class="ask-insights-title">✦ Conclusiones Clave:</div>
            <ul class="ask-insights-list">
              ${data.keyInsights.map(k => `<li>${escapeHtml(k)}</li>`).join('')}
            </ul>
          ` : '';

        const sourcesHtml = (data.sources && data.sources.length > 0)
          ? `
            <div class="ask-sources-header">Fuentes Consultadas de tu Biblioteca:</div>
            <div class="ask-sources-grid">
              ${data.sources.map(s => `
                <div class="ask-source-item" id="source-${s.index}">
                  <div class="ask-source-top">
                    <span class="ask-source-idx">[${s.index}]</span>
                    <span class="badge badge-accent">${Math.round(s.similarityScore * 100)}% afinidad</span>
                  </div>
                  <h5 class="ask-source-title">${escapeHtml(s.title || s.uri)}</h5>
                  <div class="ask-source-meta">
                    <span>${escapeHtml(s.channelOrDomain || 'Web')}</span>
                    <a href="${escapeHtml(s.uri)}" target="_blank" rel="noopener" class="source-link">Abrir ↗</a>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : '';

        resultsBox.innerHTML = `
          <div class="ask-answer-card">
            <div class="feed-header" style="padding-bottom: 0.6rem; margin-bottom: 0.8rem;">
              <span class="feed-title" style="font-size: 1.05rem;">Síntesis de Biblioteca</span>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-clear-ask-results">Cerrar</button>
            </div>
            <div class="ask-answer-text">${formattedAnswer}</div>
            ${insightsHtml}
            ${sourcesHtml}
          </div>
        `;

        document.getElementById('btn-clear-ask-results')?.addEventListener('click', () => {
          resultsBox.style.display = 'none';
          resultsBox.innerHTML = '';
        });
      }
    } catch (err) {
      resultsBox.innerHTML = `
        <div class="form-error">
          ${escapeHtml(err.message || 'Error en la consulta')}
        </div>
      `;
      showToast(err.message, 'error');
    } finally {
      btnSubmit.disabled = false;
      spinner.style.display = 'none';
    }
  });
}

async function loadContents() {
  try {
    const status = elements.filterStatus.value;
    const query = status ? `?status=${encodeURIComponent(status)}&limit=50` : '?limit=50';
    const res = await fetch(`/api/contents${query}`);
    if (!res.ok) throw new Error('No se pudo cargar la lista de contenidos');

    const data = await res.json();
    state.contents = data.items;
    elements.feedCount.textContent = `${data.total} ${data.total === 1 ? 'contenido' : 'contenidos'}`;

    renderContentsList(data.items);
    checkInFlightPolling(data.items);
  } catch (err) {
    elements.contentsList.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--color-danger);">Error al cargar contenidos: ${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

let isInFlightPollActive = false;

function checkInFlightPolling(items) {
  const inFlightCount = items.filter(i => ['pending', 'extracting', 'summarizing', 'embedding'].includes(i.ingestStatus) || i.isEvaluating).length;

  if (inFlightCount > 0) {
    elements.inboxActiveCount.textContent = inFlightCount;
    elements.inboxActiveCount.style.display = 'inline-block';

    if (!state.inFlightPollingTimer) {
      state.inFlightPollingTimer = setInterval(async () => {
        if (document.hidden) return;
        if (isInFlightPollActive) return;
        isInFlightPollActive = true;
        try {
          const prevReadyCount = state.contents.filter(i => i.ingestStatus === 'ready').length;
          await loadContents();
          const newReadyCount = state.contents.filter(i => i.ingestStatus === 'ready').length;
          if (newReadyCount !== prevReadyCount) {
            await loadProjects();
            await loadSuggestions();
          }
        } finally {
          isInFlightPollActive = false;
        }
      }, 3000);
    }
  } else {
    elements.inboxActiveCount.style.display = 'none';
    if (state.inFlightPollingTimer) {
      clearInterval(state.inFlightPollingTimer);
      state.inFlightPollingTimer = null;
    }
  }
}

function renderContentsList(items) {
  if (items.length === 0) {
    elements.contentsList.innerHTML = `
      <div class="empty-state">
        <p>No hay contenidos procesados en este momento.</p>
      </div>
    `;
    return;
  }

  elements.contentsList.innerHTML = items.map(item => {
    const statusLabel = STATUS_LABELS[item.ingestStatus] || item.ingestStatus;
    const isFailed = item.ingestStatus === 'failed';
    const dateFormatted = new Date(item.consumedAt).toLocaleString('es-ES', {
      dateStyle: 'short',
      timeStyle: 'short',
    });

    let displayTitle = item.title || 'Extrayendo título...';
    if (item.channelOrDomain && !displayTitle.toLowerCase().includes(item.channelOrDomain.toLowerCase())) {
      displayTitle = `${displayTitle} — ${item.channelOrDomain}`;
    }

    // Determine primary evaluation status chip
    let triageBadgeHtml = '';
    if (item.ingestStatus === 'ready') {
      if (item.isEvaluating) {
        triageBadgeHtml = `<span class="chip chip-neutral" style="background: hsla(270, 80%, 65%, 0.15); color: #c4b5fd; border: 1px solid hsla(270, 80%, 65%, 0.35);"><span class="spinner" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-right:5px;border-width:1.5px;"></span>Evaluando LLM...</span>`;
      } else if (item.counts.actionable > 0) {
        triageBadgeHtml = `<span class="chip chip-actionable">⚡ Accionable (${item.counts.actionable})</span>`;
      } else if (item.counts.tentative > 0) {
        triageBadgeHtml = `<span class="chip chip-tentative">👁️ Tentativo (${item.counts.tentative})</span>`;
      } else if (item.counts.irrelevant > 0) {
        triageBadgeHtml = `<span class="chip chip-discarded">✕ Descartado por LLM</span>`;
      } else {
        triageBadgeHtml = `<span class="chip chip-neutral">Sin afinidad (Paso 1)</span>`;
      }
    } else {
      triageBadgeHtml = `<span class="chip ${item.ingestStatus}">${statusLabel}</span>`;
    }

    // Build preview for evaluations (LLM reasoning and project verdict)
    const evalsList = item.evaluationsList || [];
    let evaluationsPreviewHtml = '';
    if (evalsList.length > 0) {
      evaluationsPreviewHtml = `
        <div class="content-evaluations-preview">
          ${evalsList.map(ev => {
            const vLabel = ev.verdict === 'actionable' ? 'Accionable' : (ev.verdict === 'tentative' ? 'Tentativo' : 'Descartado');
            const vRowClass = ev.verdict === 'actionable' ? 'ready' : (ev.verdict === 'tentative' ? 'tentative' : 'failed');
            const chipClass = ev.verdict === 'tentative' ? 'chip-tentative' : (ev.verdict === 'actionable' ? 'chip-actionable' : 'chip-discarded');
            const scorePct = Math.round((ev.confidenceScore || 0) * 100);
            return `
              <div class="content-eval-row ${vRowClass}">
                <div class="content-eval-badge-line">
                  <span class="content-eval-project-name">${escapeHtml(ev.projectTitle)}</span>
                  <span class="chip chip-sm ${chipClass}">
                    ${ev.verdict === 'irrelevant' ? vLabel : `${vLabel} (${scorePct}%)`}
                  </span>
                </div>
                ${ev.triageReasoning ? `
                  <p class="content-eval-snippet">${escapeHtml(ev.triageReasoning)}</p>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    return `
      <div class="glass-card content-item-card" id="content-card-${item.id}">
        <div class="content-item-top">
          <div style="flex: 1;">
            <a href="javascript:void(0)" class="content-item-title" data-content-id="${item.id}">
              ${escapeHtml(displayTitle)}
            </a>
            <div class="content-item-subline">
              ${item.channelOrDomain ? `
                <span class="content-item-author-tag">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                  ${escapeHtml(item.channelOrDomain)}
                </span>
              ` : ''}
              <span class="content-item-uri">${escapeHtml(item.uri)}</span>
            </div>
          </div>
          ${triageBadgeHtml}
        </div>

        ${evaluationsPreviewHtml}

        ${isFailed && item.ingestStatusReason ? `
          <div style="margin: 0.6rem 0; font-size: 0.85rem; color: var(--color-danger); background: hsla(350, 85%, 60%, 0.1); padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); border: 1px solid hsla(350, 85%, 60%, 0.25); display: flex; align-items: center; justify-content: space-between;">
            <div>
              <strong>Error:</strong> ${escapeHtml(item.ingestStatusReason)}
            </div>
            <button type="button" class="btn btn-secondary btn-retry" data-retry-url="${escapeHtml(item.uri)}" style="padding: 0.25rem 0.75rem; font-size: 0.75rem;">
              Reintentar
            </button>
          </div>
        ` : ''}

        <div class="content-item-meta">
          <span class="content-item-meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            ${dateFormatted}
          </span>
          <span class="content-item-meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            ${item.counts.evaluations > 0 
              ? `${item.counts.evaluations} evaluaci${item.counts.evaluations === 1 ? 'ón' : 'ones'} (${item.counts.actionable} accionables, ${item.counts.tentative || 0} tentativas)` 
              : (item.isEvaluating ? 'Evaluando con IA...' : (item.ingestStatus !== 'ready' ? (STATUS_LABELS[item.ingestStatus] || item.ingestStatus) : 'Filtrado en Paso 1 (sin coincidencia semántica)'))}
          </span>
          <button type="button" class="btn btn-secondary btn-detail" data-content-id="${item.id}" style="margin-left: auto; padding: 0.35rem 0.85rem; font-size: 0.8rem;">
            Ver Detalle
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Event Listeners for items
  elements.contentsList.querySelectorAll('.btn-detail, .content-item-title').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.contentId;
      openContentDetailModal(id);
    });
  });

  elements.contentsList.querySelectorAll('.btn-retry').forEach(el => {
    el.addEventListener('click', async (e) => {
      const url = e.currentTarget.dataset.retryUrl;
      await retryIngestion(url);
    });
  });
}

async function retryIngestion(url) {
  try {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error('Error al reintentar');
    showToast('Reintentando procesamiento del enlace...', 'info');
    loadContents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================================================
// View B: Tablero de Triaje (Triage Board) Logic
// ==========================================================================

async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Error al cargar proyectos');
    const data = await res.json();
    state.projects = data.projects;

    updateAllCountsAndBadges();
  } catch (err) {
    console.error('Error loading projects:', err);
  }
}

function updateAllCountsAndBadges() {
  const totalActiveAll = state.projects.reduce((acc, p) => acc + (p.counts?.active ?? ((p.counts?.pending || 0) + (p.counts?.tentative || 0))), 0);
  const totalPendingAll = state.projects.reduce((acc, p) => acc + (p.counts?.pending || 0), 0);
  const totalTentativeAll = state.projects.reduce((acc, p) => acc + (p.counts?.tentative || 0), 0);
  const totalAcceptedAll = state.projects.reduce((acc, p) => acc + (p.counts?.accepted || 0), 0);
  const totalDiscardedAll = state.projects.reduce((acc, p) => acc + (p.counts?.discarded || 0), 0);

  // Header badges (display active non-discarded count)
  if (elements.triagePendingBadge) {
    elements.triagePendingBadge.textContent = totalActiveAll;
  }
  if (elements.projectsCount) {
    elements.projectsCount.textContent = state.projects.length;
  }

  // Triage Tab badges for the currently selected project (or all)
  let currentActive = totalActiveAll;
  let currentPending = totalPendingAll;
  let currentAccepted = totalAcceptedAll;
  let currentTentative = totalTentativeAll;
  let currentDiscarded = totalDiscardedAll;

  if (state.selectedProjectId) {
    const selectedProj = state.projects.find(p => p.id === state.selectedProjectId);
    currentActive = selectedProj?.counts?.active ?? ((selectedProj?.counts?.pending || 0) + (selectedProj?.counts?.tentative || 0));
    currentPending = selectedProj?.counts?.pending || 0;
    currentAccepted = selectedProj?.counts?.accepted || 0;
    currentTentative = selectedProj?.counts?.tentative || 0;
    currentDiscarded = selectedProj?.counts?.discarded || 0;
  }

  if (elements.badgeActive) elements.badgeActive.textContent = currentActive;
  if (elements.badgePending) elements.badgePending.textContent = currentPending;
  if (elements.badgeTentative) elements.badgeTentative.textContent = currentTentative;
  if (elements.badgeAccepted) elements.badgeAccepted.textContent = currentAccepted;
  if (elements.badgeDiscarded) elements.badgeDiscarded.textContent = currentDiscarded;

  renderProjectsSidebar();
}

function renderProjectsSidebar() {
  const totalActiveAll = state.projects.reduce((acc, p) => acc + (p.counts?.active ?? ((p.counts?.pending || 0) + (p.counts?.tentative || 0))), 0);

  const allProjectsItem = `
    <button type="button" class="project-item ${state.selectedProjectId === null ? 'active' : ''}" id="project-filter-all" data-project-id="all">
      <span class="project-item-title">Todos los Proyectos</span>
      <span class="pill-badge" id="badge-all-pending">${totalActiveAll}</span>
    </button>
  `;

  const projectItems = state.projects.map(p => {
    const activeCount = p.counts?.active ?? ((p.counts?.pending || 0) + (p.counts?.tentative || 0));
    return `
      <button type="button" class="project-item ${state.selectedProjectId === p.id ? 'active' : ''}" id="project-filter-${p.id}" data-project-id="${p.id}">
        <span class="project-item-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>
        <span class="pill-badge">${activeCount}</span>
      </button>
    `;
  }).join('');

  elements.projectsList.innerHTML = allProjectsItem + projectItems;

  elements.projectsList.querySelectorAll('.project-item').forEach(el => {
    el.addEventListener('click', (e) => {
      const pid = e.currentTarget.dataset.projectId;
      selectProject(pid === 'all' ? null : pid);
    });
  });
}

function selectProject(projectId) {
  state.selectedProjectId = projectId;
  state.renderedSuggestionsSignature = ''; // Force re-render on project switch

  if (projectId === null) {
    elements.selectedProjectTitle.textContent = 'Todos los Proyectos';
    elements.selectedProjectThesis.textContent = 'Revisando sugerencias cruzadas entre todos tus proyectos de investigación.';
    if (elements.projectHeroActions) elements.projectHeroActions.style.display = 'none';
  } else {
    const proj = state.projects.find(p => p.id === projectId);
    if (proj) {
      elements.selectedProjectTitle.textContent = proj.title;
      elements.selectedProjectThesis.textContent = proj.thesisText || 'Sin tesis definida.';
    }
    if (elements.projectHeroActions) elements.projectHeroActions.style.display = 'flex';
  }

  updateAllCountsAndBadges();
  loadSuggestions();
  renderSynergies();
}

function setupTriageStatusTabs() {
  const tabs = [
    { el: elements.tabStatusActive, status: 'active' },
    { el: elements.tabStatusPending, status: 'pending' },
    { el: elements.tabStatusTentative, status: 'tentative' },
    { el: elements.tabStatusAccepted, status: 'accepted' },
    { el: elements.tabStatusDiscarded, status: 'discarded' },
  ];

  tabs.forEach(({ el, status }) => {
    el.addEventListener('click', () => {
      tabs.forEach(t => {
        t.el.classList.remove('active');
        t.el.setAttribute('aria-selected', 'false');
      });
      el.classList.add('active');
      el.setAttribute('aria-selected', 'true');
      state.selectedSuggestionStatus = status;
      state.renderedSuggestionsSignature = ''; // Force re-render on tab switch
      loadSuggestions();
    });
  });
}

async function loadSuggestions() {
  try {
    const params = new URLSearchParams({
      status: state.selectedSuggestionStatus,
      limit: '50',
    });

    if (state.selectedProjectId) {
      params.append('projectId', state.selectedProjectId);
    }

    const res = await fetch(`/api/suggestions?${params.toString()}`);
    if (!res.ok) throw new Error('Error al cargar sugerencias');

    const data = await res.json();
    state.suggestions = data.items;

    // Sync authoritative count returned by DB query for the currently active tab
    if (state.selectedProjectId) {
      const proj = state.projects.find(p => p.id === state.selectedProjectId);
      if (proj && proj.counts) {
        proj.counts[state.selectedSuggestionStatus] = data.total;
      }
    }

    updateAllCountsAndBadges();
    renderSuggestionsList(data.items);
  } catch (err) {
    elements.suggestionsList.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--color-danger);">Error al cargar sugerencias: ${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

function renderSuggestionsList(items) {
  const currentSignature = `${state.selectedProjectId || 'all'}:${state.selectedSuggestionStatus}:${items.map(s => `${s.id}-${s.status}-${s.writtenToVault}`).join(',')}`;
  if (currentSignature === state.renderedSuggestionsSignature) {
    // Structure and items haven't changed: do not rebuild DOM to keep disclosure widgets open and inputs focused
    return;
  }
  state.renderedSuggestionsSignature = currentSignature;

  if (items.length === 0) {
    const statusText = state.selectedSuggestionStatus === 'active'
      ? 'No hay sugerencias activas (accionables o tentativas) para este proyecto.'
      : state.selectedSuggestionStatus === 'pending' 
      ? 'No hay sugerencias pendientes de revisión.' 
      : state.selectedSuggestionStatus === 'tentative'
      ? 'No hay evaluaciones con afinidad tentativa para este proyecto.'
      : state.selectedSuggestionStatus === 'accepted' 
      ? 'Aún no has aceptado ninguna sugerencia para este proyecto.' 
      : 'No hay sugerencias descartadas para este proyecto.';

    elements.suggestionsList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 0.75rem; color: var(--text-tertiary);">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <p>${statusText}</p>
      </div>
    `;
    return;
  }

  elements.suggestionsList.innerHTML = items.map((sug, index) => {
    const isTentative = sug.status === 'tentative';
    const isPending = sug.status === 'pending';
    const isAccepted = sug.status === 'accepted';
    const isDiscarded = sug.status === 'discarded';

    let actionLabel = ACTION_LABELS[sug.actionType] || sug.actionType;
    let chipClass = sug.actionType || 'chip-neutral';
    let chipStyle = '';

    if (isTentative) {
      actionLabel = '👁️ Tentativo';
      chipClass = 'chip-tentative';
      chipStyle = 'background: hsla(38, 95%, 55%, 0.15); color: #fbbf24; border: 1px solid hsla(38, 95%, 55%, 0.35);';
    } else if (isDiscarded) {
      actionLabel = sug.targetFile === 'discarded' ? '✕ Descarte IA' : '✕ Descartado';
      chipClass = 'chip-discarded';
      chipStyle = 'background: hsla(0, 80%, 55%, 0.15); color: #f87171; border: 1px solid hsla(0, 80%, 55%, 0.35);';
    } else if (isAccepted) {
      actionLabel = '✓ Aceptada';
      chipClass = 'chip-actionable';
      chipStyle = 'background: hsla(142, 70%, 45%, 0.15); color: #4ade80; border: 1px solid hsla(142, 70%, 45%, 0.35);';
    }

    const dateFormatted = new Date(sug.createdAt).toLocaleDateString('es-ES');
    const isOpen = state.openDetails.has(sug.id);
    const cachedReasoning = state.loadedReasonings.get(sug.id);
    const draftFeedback = state.feedbackDrafts.get(sug.id) || '';

    const percent = Math.round((sug.confidenceScore || 0) * 100);
    const reasoningContent = sug.triageReasoning ? `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem;">
        <span><strong>Veredicto:</strong> <code>${escapeHtml(isTentative ? 'tentative' : (isDiscarded ? 'irrelevant' : 'actionable'))}</code></span>
        ${!isDiscarded ? `
          <div class="confidence-meter">
            <span>Afinidad: <strong>${percent}%</strong></span>
            <div class="confidence-bar-bg">
              <div class="confidence-bar-fill" style="width: ${percent}%;"></div>
            </div>
          </div>
        ` : ''}
      </div>
      <p style="margin-bottom: 0.5rem;"><strong>Razonamiento del modelo:</strong></p>
      <p style="background: hsla(220, 20%, 10%, 0.5); padding: 0.6rem; border-radius: 6px; font-size: 0.85rem; line-height: 1.4;">
        ${escapeHtml(sug.triageReasoning)}
      </p>
    ` : (cachedReasoning || `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <span><strong>Destino de nota:</strong> <code>${escapeHtml(sug.targetFile)}</code></span>
        <span class="badge ${sug.writtenToVault ? 'badge-accent' : 'badge-subtle'}">
          ${sug.writtenToVault ? 'En Obsidian' : 'Pendiente de Vault'}
        </span>
      </div>
      <p style="font-style: italic;">Cargando análisis profundo...</p>
    `);

    // Prominent discard rationale box for discarded items
    const discardedReasonBox = isDiscarded && sug.triageReasoning ? `
      <div style="background: hsla(0, 50%, 20%, 0.2); border: 1px solid hsla(0, 50%, 40%, 0.25); border-radius: 8px; padding: 0.75rem; margin: 0.75rem 0;">
        <div style="font-size: 0.75rem; color: #f87171; font-weight: 600; text-transform: uppercase; margin-bottom: 0.25rem;">
          Motivo del descarte (LLM)
        </div>
        <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4; margin: 0;">
          ${escapeHtml(sug.triageReasoning)}
        </p>
      </div>
    ` : '';

    return `
      <div class="glass-card suggestion-card" id="sug-card-${sug.id}" data-id="${sug.id}">
        <div class="suggestion-header">
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <span class="action-chip ${chipClass}" style="${chipStyle}">${actionLabel}</span>
            <span class="suggestion-project-tag">${escapeHtml(sug.projectTitle || 'Proyecto')}</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-tertiary);">${dateFormatted}</span>
        </div>

        <h4 class="suggestion-action-title">${escapeHtml(sug.suggestedAction)}</h4>
        <p class="suggestion-observation">${escapeHtml(sug.observation)}</p>

        <div class="obsidian-callout-preview ${isAccepted ? 'callout-accepted' : ''}">
          <div class="obsidian-callout-header">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <span>${isAccepted ? 'Integrado en Obsidian' : 'Callout de Obsidian'} &gt; [!tip]</span>
          </div>
          <div class="obsidian-callout-target">
            Nota destino: <code>${escapeHtml(sug.targetFile && sug.targetFile !== 'discarded' ? sug.targetFile : 'suggestions.md')}</code>
          </div>
          <div class="obsidian-callout-text">
            &ldquo;${escapeHtml(sug.suggestedAction)}&rdquo;
          </div>
        </div>

        ${discardedReasonBox}

        <div class="suggestion-source">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
          <span>Fuente:</span>
          <a href="${safeUrl(sug.contentUri)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(sug.contentTitle || sug.contentUri)}
          </a>
        </div>

        <!-- Collapsible AI Reasoning Details -->
        <details class="ai-triage-details" ${isOpen ? 'open' : ''}>
          <summary class="ai-triage-summary">
            <span>¿Por qué esta sugerencia? (Evaluación IA)</span>
            <span style="font-size: 0.75rem; color: var(--accent-primary);">Ver Razonamiento</span>
          </summary>
          <div class="ai-triage-content" id="triage-details-${sug.id}">
            ${reasoningContent}
          </div>
        </details>

        ${(isPending || isTentative) ? `
          <div class="suggestion-footer">
            <div class="feedback-input-wrapper">
              <label for="feedback-${sug.id}" class="visually-hidden">Nota opcional para Obsidian</label>
              <input 
                type="text" 
                id="feedback-${sug.id}" 
                class="feedback-input" 
                placeholder="${isTentative ? 'Nota opcional al integrar...' : 'Añadir nota opcional para Obsidian...'}"
                value="${escapeHtml(draftFeedback)}"
              >
            </div>
            <div class="suggestion-actions">
              <button type="button" class="btn btn-danger btn-discard" id="btn-discard-${sug.id}" data-id="${sug.id}">
                Descartar
              </button>
              <button type="button" class="btn btn-success btn-accept" id="btn-accept-${sug.id}" data-id="${sug.id}">
                ${isTentative ? 'Integrar' : 'Aceptar'}
              </button>
            </div>
          </div>
        ` : `
          <div class="suggestion-footer" style="justify-content: flex-end;">
            <span style="font-size: 0.8rem; color: ${isAccepted ? 'var(--color-success)' : 'var(--color-danger)'}; font-weight: 600;">
              ${isAccepted ? '✓ Aceptada e integrada en Obsidian' : `✕ Descartada ${sug.targetFile === 'discarded' ? 'por el modelo LLM' : 'por el usuario'}`}
            </span>
          </div>
        `}
      </div>
    `;
  }).join('');

  // Setup Event Listeners for Suggestion Cards
  elements.suggestionsList.querySelectorAll('.suggestion-card').forEach((card) => {
    // Save draft feedback as user types
    const feedbackInput = card.querySelector('.feedback-input');
    if (feedbackInput) {
      feedbackInput.addEventListener('input', (e) => {
        state.feedbackDrafts.set(card.dataset.id, e.target.value);
      });
    }

    // Lazy load reasoning on details toggle and preserve open/closed state
    const details = card.querySelector('.ai-triage-details');
    if (details) {
      details.addEventListener('toggle', async () => {
        const sugId = card.dataset.id;
        if (details.open) {
          state.openDetails.add(sugId);
          if (!state.loadedReasonings.has(sugId)) {
            await loadSuggestionReasoning(sugId);
          }
        } else {
          state.openDetails.delete(sugId);
        }
      });
    }
  });

  // Accept and Discard buttons
  elements.suggestionsList.querySelectorAll('.btn-accept').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const feedbackInput = document.getElementById(`feedback-${id}`);
      const feedback = feedbackInput ? feedbackInput.value.trim() : '';
      resolveSuggestion(id, 'accepted', feedback);
    });
  });

  elements.suggestionsList.querySelectorAll('.btn-discard').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const feedbackInput = document.getElementById(`feedback-${id}`);
      const feedback = feedbackInput ? feedbackInput.value.trim() : '';
      resolveSuggestion(id, 'discarded', feedback);
    });
  });
}

async function loadSuggestionReasoning(suggestionId) {
  const container = document.getElementById(`triage-details-${suggestionId}`);
  if (!container) return;

  try {
    const res = await fetch(`/api/suggestions/${suggestionId}`);
    if (!res.ok) throw new Error('No se pudo cargar el detalle');
    const data = await res.json();

    const percent = Math.round((data.confidenceScore || 0) * 100);

    const html = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem;">
        <span><strong>Veredicto:</strong> <code>${escapeHtml(data.triageVerdict || 'actionable')}</code></span>
        ${data.triageVerdict !== 'irrelevant' ? `
          <div class="confidence-meter">
            <span>Afinidad: <strong>${percent}%</strong></span>
            <div class="confidence-bar-bg">
              <div class="confidence-bar-fill" style="width: ${percent}%;"></div>
            </div>
          </div>
        ` : ''}
      </div>
      <p style="margin-bottom: 0.5rem;"><strong>Razonamiento del modelo:</strong></p>
      <p style="background: hsla(220, 20%, 10%, 0.5); padding: 0.6rem; border-radius: 6px;">
        ${escapeHtml(data.triageReasoning || 'Sin justificación disponible.')}
      </p>
    `;

    state.loadedReasonings.set(suggestionId, html);
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p style="color: var(--color-danger);">${escapeHtml(err.message)}</p>`;
  }
}

async function resolveSuggestion(suggestionId, status, userFeedback = '') {
  const card = document.getElementById(`sug-card-${suggestionId}`);
  if (card) {
    card.classList.add('dismissed');
  }

  // Clear cached draft and details state
  state.openDetails.delete(suggestionId);
  state.loadedReasonings.delete(suggestionId);
  state.feedbackDrafts.delete(suggestionId);
  state.renderedSuggestionsSignature = ''; // Force re-render to reflect resolved item

  // 1. Optimistic Count Update
  const sug = state.suggestions.find(s => s.id === suggestionId);
  if (sug) {
    const proj = state.projects.find(p => p.id === sug.projectId);
    if (proj && proj.counts) {
      if (sug.status === 'pending' && proj.counts.pending > 0) proj.counts.pending--;
      if (sug.status === 'tentative' && proj.counts.tentative > 0) proj.counts.tentative--;
      if (proj.counts.active > 0) proj.counts.active--;
      if (status === 'accepted') proj.counts.accepted = (proj.counts.accepted || 0) + 1;
      if (status === 'discarded') proj.counts.discarded = (proj.counts.discarded || 0) + 1;
    }
    updateAllCountsAndBadges();
  }

  try {
    const res = await fetch(`/api/suggestions/${suggestionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        userFeedback: userFeedback || undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Error al actualizar');

    if (status === 'accepted') {
      showToast('Sugerencia aceptada y escrita en suggestions.md en Obsidian.', 'success');
    } else {
      showToast('Sugerencia descartada.', 'info');
    }

    // 2. Synchronize authoritative state from backend
    await loadProjects();
    await loadSuggestions();
  } catch (err) {
    if (card) {
      card.classList.remove('dismissed');
    }
    await loadProjects();
    await loadSuggestions();
    showToast(err.message, 'error');
  }
}


// ==========================================================================
// Detail Modal
// ==========================================================================

function setupModalEvents() {
  elements.btnCloseModal.addEventListener('click', () => {
    elements.contentDetailModal.close();
  });

  elements.contentDetailModal.addEventListener('click', (e) => {
    if (e.target === elements.contentDetailModal) {
      elements.contentDetailModal.close();
    }
  });
}

// ==========================================================================
// Feature 4: Synthesize Project Backlog
// ==========================================================================

function setupSynthesisAction() {
  if (elements.btnCloseSynthesisModal && elements.synthesisResultModal) {
    elements.btnCloseSynthesisModal.addEventListener('click', () => {
      elements.synthesisResultModal.close();
    });
    elements.synthesisResultModal.addEventListener('click', (e) => {
      if (e.target === elements.synthesisResultModal) {
        elements.synthesisResultModal.close();
      }
    });
  }

  if (elements.btnSynthesizeProject) {
    elements.btnSynthesizeProject.addEventListener('click', handleSynthesizeProject);
  }
}

async function handleSynthesizeProject() {
  if (!state.selectedProjectId) {
    showToast('Selecciona un proyecto específico para sintetizar su backlog.', 'warning');
    return;
  }

  const proj = state.projects.find(p => p.id === state.selectedProjectId);
  const acceptedCount = proj?.counts?.accepted ?? 0;

  if (acceptedCount === 0) {
    showToast('No hay sugerencias aceptadas en este proyecto para sintetizar. Acepta al menos una sugerencia antes de compilar el Research Brief.', 'warning');
    return;
  }

  // Set loading state
  elements.btnSynthesizeProject.disabled = true;
  elements.btnSynthesizeText.textContent = 'Sintetizando...';
  elements.synthesizeSpinner.style.display = 'inline-block';

  try {
    const res = await fetch(`/api/projects/${state.selectedProjectId}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Error al generar la síntesis del proyecto.');
    }

    // Open Synthesis Result Modal
    openSynthesisResultModal(data, proj?.title || 'Proyecto');
    showToast(`Research Brief generado y guardado en Obsidian: ${data.filePath}`, 'success');

    // Reload projects to update notes and snapshots
    loadProjects();
  } catch (err) {
    console.error('Synthesis error:', err);
    showToast(err.message || 'Error al compilar la síntesis.', 'error');
  } finally {
    elements.btnSynthesizeProject.disabled = false;
    elements.btnSynthesizeText.textContent = '✦ Sintetizar Backlog';
    elements.synthesizeSpinner.style.display = 'none';
  }
}

function openSynthesisResultModal(data, projectTitle) {
  if (!elements.synthesisResultModal) return;

  elements.synthesisModalTitle.textContent = data.title || `Research Brief — ${projectTitle}`;

  const nextStepsHtml = (data.suggestedNextSteps || []).length > 0
    ? `
      <div class="synthesis-section">
        <span class="synthesis-section-title">Próximos Pasos Recomendados</span>
        <ul class="synthesis-steps-list">
          ${(data.suggestedNextSteps || []).map(step => `
            <li class="synthesis-step-item">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              <span>${escapeHtml(step)}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    `
    : '';

  elements.synthesisModalBody.innerHTML = `
    <div class="synthesis-content-view">
      <div class="synthesis-meta-bar">
        <div class="synthesis-meta-path">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>Vault: <code>${escapeHtml(data.filePath)}</code></span>
        </div>
        <span class="chip chip-actionable">${data.acceptedCount} sugerencias integradas</span>
      </div>

      <div class="synthesis-section">
        <span class="synthesis-section-title">Resumen Ejecutivo</span>
        <div class="synthesis-summary-text">${escapeHtml(data.executiveSummary).replace(/\n/g, '<br>')}</div>
      </div>

      ${nextStepsHtml}

      <div class="synthesis-actions-bar">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-synthesis-summary">Copiar Resumen</button>
        <button type="button" class="btn btn-primary btn-sm" id="btn-confirm-synthesis-modal">Listo</button>
      </div>
    </div>
  `;

  document.getElementById('btn-confirm-synthesis-modal')?.addEventListener('click', () => {
    elements.synthesisResultModal.close();
  });

  document.getElementById('btn-copy-synthesis-summary')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${data.title}\n\n${data.executiveSummary}`);
      showToast('Resumen copiado al portapapeles', 'info');
    } catch {
      showToast('No se pudo copiar automáticamente', 'warning');
    }
  });

  elements.synthesisResultModal.showModal();
}

// ==========================================================================
// Feature 5: Cross-Project Synergies
// ==========================================================================

function setupSynergies() {
  if (elements.btnRefreshSynergies) {
    elements.btnRefreshSynergies.addEventListener('click', () => {
      loadSynergies(true);
    });
  }

  if (elements.btnCloseSynergyModal && elements.synergyBridgeModal) {
    elements.btnCloseSynergyModal.addEventListener('click', () => {
      elements.synergyBridgeModal.close();
    });
    elements.synergyBridgeModal.addEventListener('click', (e) => {
      if (e.target === elements.synergyBridgeModal) {
        elements.synergyBridgeModal.close();
      }
    });
  }
}

async function loadSynergies(isManualRefresh = false) {
  try {
    const res = await fetch('/api/projects/synergies');
    if (!res.ok) return;
    const data = await res.json();
    state.synergies = data.synergies || [];
    renderSynergies();
    if (isManualRefresh) {
      showToast(`${state.synergies.length} sinergias calculadas con éxito`, 'info');
    }
  } catch (err) {
    console.error('Failed to load synergies:', err);
  }
}

function renderSynergies() {
  if (!elements.synergiesSection || !elements.synergiesGrid) return;

  // Filter synergies by currently selected project (if one is selected)
  let visibleSynergies = state.synergies;
  if (state.selectedProjectId) {
    visibleSynergies = state.synergies.filter(s =>
      s.projectA.id === state.selectedProjectId || s.projectB.id === state.selectedProjectId
    );
  }

  if (visibleSynergies.length === 0) {
    elements.synergiesSection.style.display = 'none';
    return;
  }

  elements.synergiesSection.style.display = 'block';
  if (elements.synergiesCountBadge) {
    elements.synergiesCountBadge.textContent = `${visibleSynergies.length} Sinergia${visibleSynergies.length === 1 ? '' : 's'}`;
  }

  elements.synergiesGrid.innerHTML = visibleSynergies.map(s => {
    const notesHtml = (s.closestNotes && s.closestNotes.length > 0)
      ? `
        <div class="synergy-notes-box">
          <span class="synergy-notes-label">Notas con mayor afinidad:</span>
          ${s.closestNotes.slice(0, 2).map(n => `
            <div class="synergy-notes-pair">
              <span class="synergy-note-link" title="${escapeHtml(n.noteAPath)}">[[${escapeHtml(n.noteATitle)}]]</span>
              <span class="synergy-arrow">⇄</span>
              <span class="synergy-note-link" title="${escapeHtml(n.noteBPath)}">[[${escapeHtml(n.noteBSTitle)}]]</span>
            </div>
          `).join('')}
        </div>
      `
      : '';

    return `
      <div class="synergy-card">
        <div class="synergy-card-header">
          <div class="synergy-proj-bridge">
            <span class="synergy-proj-name" title="${escapeHtml(s.projectA.title)}">${escapeHtml(s.projectA.title)}</span>
            <span class="synergy-arrow">⇄</span>
            <span class="synergy-proj-name" title="${escapeHtml(s.projectB.title)}">${escapeHtml(s.projectB.title)}</span>
          </div>
          <span class="synergy-score-chip">${s.similarityScore}% Afinidad</span>
        </div>

        <p class="synergy-rationale">${escapeHtml(s.rationale)}</p>

        ${notesHtml}

        <div class="synergy-card-footer">
          <button type="button" class="btn btn-secondary btn-sm btn-explore-synergy" 
            data-proj-a="${s.projectA.id}" 
            data-proj-b="${s.projectB.id}"
            data-title-a="${escapeHtml(s.projectA.title)}"
            data-title-b="${escapeHtml(s.projectB.title)}"
          >
            <span>✦ Explorar Puente</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  elements.synergiesGrid.querySelectorAll('.btn-explore-synergy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget;
      const pA = target.dataset.projA;
      const pB = target.dataset.projB;
      const tA = target.dataset.titleA;
      const tB = target.dataset.titleB;
      exploreSynergyBridge(pA, pB, tA, tB);
    });
  });
}

async function exploreSynergyBridge(projectAId, projectBId, titleA, titleB) {
  if (!elements.synergyBridgeModal) return;

  elements.synergyModalTitle.textContent = `Puente: ${titleA} ⇄ ${titleB}`;
  elements.synergyModalBody.innerHTML = `
    <div style="text-align: center; padding: 3rem 1.5rem;">
      <span class="spinner large"></span>
      <p style="color: var(--text-secondary); margin-top: 1rem;">Sintetizando conexiones temáticas y metodológicas entre ambos proyectos...</p>
    </div>
  `;
  elements.synergyBridgeModal.showModal();

  try {
    const res = await fetch('/api/projects/synergies/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectAId, projectBId, saveToVault: true }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Error al generar el puente de sinergia.');
    }

    elements.synergyModalTitle.textContent = data.bridgeTitle;

    const vaultBadge = data.writtenToVault && data.filePath
      ? `<span class="chip chip-actionable">Guardado en Vault: ${escapeHtml(data.filePath)}</span>`
      : '';

    elements.synergyModalBody.innerHTML = `
      <div class="synthesis-content-view">
        <div class="synthesis-meta-bar">
          <div class="synergy-proj-bridge">
            <strong>[[${escapeHtml(titleA)}]]</strong>
            <span class="synergy-arrow">⇄</span>
            <strong>[[${escapeHtml(titleB)}]]</strong>
          </div>
          ${vaultBadge}
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">Resonancia Temática</span>
          <div class="synthesis-summary-text">${escapeHtml(data.overview).replace(/\n/g, '<br>')}</div>
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">Preguntas y Problemas Compartidos</span>
          <ul class="synthesis-steps-list">
            ${(data.sharedProblems || []).map(p => `
              <li class="synthesis-step-item">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>${escapeHtml(p)}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">Transferencia y Beneficios Mutuos</span>
          <ul class="synthesis-steps-list">
            ${(data.mutualBenefits || []).map(b => `
              <li class="synthesis-step-item">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                <span>${escapeHtml(b)}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        <div class="synthesis-actions-bar">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-synergy-note">Copiar Nota</button>
          <button type="button" class="btn btn-primary btn-sm" id="btn-close-synergy-view">Listo</button>
        </div>
      </div>
    `;

    document.getElementById('btn-close-synergy-view')?.addEventListener('click', () => {
      elements.synergyBridgeModal.close();
    });

    document.getElementById('btn-copy-synergy-note')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`${data.bridgeTitle}\n\n${data.overview}\n\n${data.markdownContent}`);
        showToast('Nota de sinergia copiada al portapapeles', 'info');
      } catch {
        showToast('No se pudo copiar automáticamente', 'warning');
      }
    });

    if (data.writtenToVault && data.filePath) {
      showToast(`Puente de investigación guardado en Obsidian: ${data.filePath}`, 'success');
    }
  } catch (err) {
    console.error('Synergy exploration error:', err);
    elements.synergyModalBody.innerHTML = `
      <div style="padding: 2rem 1rem; text-align: center; color: var(--color-danger);">
        <p><strong>Error al explorar sinergia:</strong> ${escapeHtml(err.message || 'Error inesperado')}</p>
        <button type="button" class="btn btn-secondary btn-sm" style="margin-top: 1rem;" onclick="document.getElementById('synergy-bridge-modal').close()">Cerrar</button>
      </div>
    `;
  }
}

async function openContentDetailModal(contentId) {
  elements.modalContentTitle.textContent = 'Cargando información...';
  elements.modalContentBody.innerHTML = '<div style="text-align: center; padding: 2.5rem 1rem;"><span class="spinner large"></span><p style="color: var(--text-secondary); margin-top: 0.75rem;">Cargando detalles del contenido...</p></div>';
  elements.contentDetailModal.showModal();

  try {
    const res = await fetch(`/api/contents/${contentId}`);
    if (!res.ok) throw new Error('No se pudo obtener el detalle');
    const data = await res.json();

    let displayTitle = data.title || 'Detalle del Contenido';
    if (data.channelOrDomain && !displayTitle.toLowerCase().includes(data.channelOrDomain.toLowerCase())) {
      displayTitle = `${displayTitle} — ${data.channelOrDomain}`;
    }
    elements.modalContentTitle.textContent = displayTitle;

    const evalsList = (data.evaluations || []).length > 0 ? (data.evaluations || []).map(ev => {
      const vLabel = ev.verdict === 'actionable' ? 'Accionable' : (ev.verdict === 'tentative' ? 'Tentativo' : 'Descartado');
      const chipClass = ev.verdict === 'actionable' ? 'chip-actionable' : (ev.verdict === 'tentative' ? 'chip-tentative' : 'chip-discarded');
      const scorePct = Math.round((ev.confidenceScore || 0) * 100);
      return `
        <div class="modal-eval-card">
          <div class="modal-eval-header">
            <strong class="modal-eval-project">${escapeHtml(ev.projectTitle)}</strong>
            <span class="chip ${chipClass}">
              ${ev.verdict === 'irrelevant' ? vLabel : `${vLabel} (${scorePct}%)`}
            </span>
          </div>
          <p class="modal-eval-reasoning">${escapeHtml(ev.triageReasoning || 'Sin justificación disponible.')}</p>
        </div>
      `;
    }).join('') : `
      <p class="modal-empty-notice">Este contenido no tuvo coincidencia semántica en el Paso 1 con los proyectos activos actuales (distancia espacial &gt; 0.60).</p>
    `;

    elements.modalContentBody.innerHTML = `
      <div class="modal-section">
        <span class="modal-section-label">Fuente & URL:</span>
        <div class="modal-source-row">
          ${data.channelOrDomain ? `
            <span class="content-item-author-tag">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
              ${escapeHtml(data.channelOrDomain)}
            </span>
          ` : ''}
          <a href="${safeUrl(data.uri)}" target="_blank" rel="noopener noreferrer" class="modal-uri-link">
            ${escapeHtml(data.uri)}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: 4px; vertical-align: middle;">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        </div>
      </div>

      <div class="modal-section">
        <span class="modal-section-label">Resumen Estructurado:</span>
        <div class="modal-summary-box">
          <p>${escapeHtml(data.summary || 'Aún no se ha generado el resumen del contenido.')}</p>
        </div>
      </div>

      <div class="modal-section">
        <span class="modal-section-label">Evaluaciones por Proyecto:</span>
        ${evalsList.length > 0 ? evalsList : '<p class="modal-empty-notice">Sin evaluaciones asociadas a proyectos para este contenido.</p>'}
      </div>
    `;
  } catch (err) {
    elements.modalContentBody.innerHTML = `
      <div class="modal-error-box">
        <p style="color: var(--color-danger); font-weight: 600;">Error al cargar detalle:</p>
        <p style="color: var(--text-secondary); margin-top: 0.25rem;">${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

// ==========================================================================
// View C: Configuración (Settings) Logic
// ==========================================================================

function setupSettingsView() {
  elements.vaultSettingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPath = elements.vaultPathInput.value.trim();
    if (!newPath) {
      showVaultFeedback('Por favor introduce una ruta válida.', 'error');
      return;
    }

    elements.btnSaveVault.disabled = true;
    elements.vaultSaveSpinner.style.display = 'inline-block';
    showVaultFeedback('', '');

    try {
      const res = await fetch('/api/settings/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath: newPath }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Error al guardar la ruta del Vault');
      }

      showVaultFeedback(data.summary?.message || 'Vault configurado y sincronizado exitosamente.', 'success');
      showToast('Configuración del Vault actualizada correctamente.', 'success');
      await loadVaultSettings();
      await loadProjects();
    } catch (err) {
      showVaultFeedback(err.message, 'error');
      showToast(err.message, 'error');
    } finally {
      elements.btnSaveVault.disabled = false;
      elements.vaultSaveSpinner.style.display = 'none';
    }
  });

  elements.btnRescanVault.addEventListener('click', async () => {
    elements.btnRescanVault.disabled = true;
    try {
      const res = await fetch('/api/settings/vault/rescan', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Error al re-escanear');
      showToast('Re-escaneo de proyectos completado.', 'success');
      await loadVaultSettings();
      await loadProjects();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      elements.btnRescanVault.disabled = false;
    }
  });
}

function showVaultFeedback(message, type) {
  if (!message) {
    elements.vaultFormFeedback.style.display = 'none';
    elements.vaultFormFeedback.textContent = '';
    elements.vaultFormFeedback.className = 'form-feedback';
    return;
  }
  elements.vaultFormFeedback.textContent = message;
  elements.vaultFormFeedback.className = `form-feedback ${type}`;
  elements.vaultFormFeedback.style.display = 'block';
}

async function loadVaultSettings() {
  try {
    const res = await fetch('/api/settings/vault');
    if (!res.ok) throw new Error('Error al consultar configuración del Vault');
    const data = await res.json();
    state.vaultStatus = data;

    renderVaultSettingsUI(data);
  } catch (err) {
    console.error('Failed to load vault settings:', err);
  }
}

function renderVaultSettingsUI(data) {
  const isHealthy = data.isConfigured && data.isValid;

  // Header and Warning Banner
  if (isHealthy) {
    if (elements.vaultWarningBanner) elements.vaultWarningBanner.style.display = 'none';
    if (elements.liveIndicator) {
      elements.liveIndicator.className = 'status-indicator live';
      elements.liveIndicator.title = 'Conexión con Obsidian activa';
    }
    if (elements.liveText) elements.liveText.textContent = 'Conectado';
  } else {
    if (elements.vaultWarningBanner) elements.vaultWarningBanner.style.display = 'flex';
    if (elements.liveIndicator) {
      elements.liveIndicator.className = 'status-indicator offline';
      elements.liveIndicator.title = 'Obsidian desconectado o sin configurar';
    }
    if (elements.liveText) elements.liveText.textContent = 'Sin Vault';
  }

  // Settings Hero Form & Status Pill
  if (data.vaultPath && document.activeElement !== elements.vaultPathInput) {
    elements.vaultPathInput.value = data.vaultPath;
  }

  if (isHealthy) {
    elements.settingsStatusPill.className = 'status-pill connected';
    elements.settingsStatusLabel.textContent = 'Vault Conectado';
  } else if (data.isConfigured && !data.isValid) {
    elements.settingsStatusPill.className = 'status-pill disconnected';
    elements.settingsStatusLabel.textContent = 'Ruta no encontrada';
  } else {
    elements.settingsStatusPill.className = 'status-pill checking';
    elements.settingsStatusLabel.textContent = 'Sin Configurar';
  }

  // Info Bar
  elements.infoActivePath.textContent = data.vaultPath || 'No configurado';
  elements.infoWatcherStatus.textContent = data.watcherActive ? 'Activo (Tiempo real)' : 'Inactivo';
  elements.infoWatcherStatus.style.color = data.watcherActive ? 'var(--color-success)' : 'var(--text-tertiary)';

  if (data.hasProjectsDir) {
    elements.infoProjectsFolder.textContent = `Detectada (${data.projectsDirName}/)`;
    elements.infoProjectsFolder.style.color = 'var(--color-success)';
  } else {
    elements.infoProjectsFolder.textContent = 'No detectada (crea Projects/)';
    elements.infoProjectsFolder.style.color = 'var(--color-warning)';
  }

  // Projects Diagnostics Table
  const projectList = data.projects || [];
  elements.settingsProjectsCount.textContent = `${projectList.length} Proyecto(s)`;

  if (projectList.length === 0) {
    elements.settingsProjectsWrapper.innerHTML = `
      <div class="empty-state">
        <p>No se encontraron proyectos registrados aún. ${data.hasProjectsDir ? 'Crea carpetas dentro de ' + (data.projectsDirName || 'Projects') + '/ para detectarlos.' : 'Configura la ruta de tu Vault para comenzar.'}</p>
      </div>
    `;
    return;
  }

  const rows = projectList.map(p => `
    <tr>
      <td>
        <strong>${escapeHtml(p.title)}</strong>
      </td>
      <td>
        <code>${escapeHtml(p.folderPath)}</code>
      </td>
      <td>
        <span class="badge badge-subtle">${p.suggestionsCount} sugerencias</span>
      </td>
      <td>
        ${p.existsOnDisk ? `
          <span class="status-chip status-chip-active">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Activo en disco
          </span>
        ` : `
          <span class="status-chip status-chip-inactive" title="La carpeta no existe en el Vault actual. Los datos históricos se conservan.">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            No encontrado (Inactivo)
          </span>
        `}
      </td>
    </tr>
  `).join('');

  elements.settingsProjectsWrapper.innerHTML = `
    <table class="settings-projects-table">
      <thead>
        <tr>
          <th>Proyecto</th>
          <th>Carpeta en Vault</th>
          <th>Sugerencias</th>
          <th>Estado en Disco</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

// Utilities
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeUrl(rawUrl) {
  if (!rawUrl) return '#';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return escapeHtml(rawUrl);
    }
    return '#';
  } catch {
    return '#';
  }
}
