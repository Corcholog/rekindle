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
  tabConsultant: document.getElementById('tab-consultant'),
  tabSettings: document.getElementById('tab-settings'),
  viewInbox: document.getElementById('view-inbox'),
  viewTriage: document.getElementById('view-triage'),
  viewConsultant: document.getElementById('view-consultant'),
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
  btnBatchReevaluate: document.getElementById('btn-batch-reevaluate'),
  batchReevaluateText: document.getElementById('batch-reevaluate-text'),
  batchReevaluateSpinner: document.getElementById('batch-reevaluate-spinner'),

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
  setupBatchReevaluateAction();
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
  if (elements.tabConsultant) {
    elements.tabConsultant.addEventListener('click', () => switchView('consultant'));
  }
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
  if (elements.tabConsultant) {
    elements.tabConsultant.classList.toggle('active', viewName === 'consultant');
  }
  if (elements.tabSettings) {
    elements.tabSettings.classList.toggle('active', viewName === 'settings');
  }

  elements.viewInbox.classList.toggle('active', viewName === 'inbox');
  elements.viewTriage.classList.toggle('active', viewName === 'triage');
  if (elements.viewConsultant) {
    elements.viewConsultant.classList.toggle('active', viewName === 'consultant');
  }
  if (elements.viewSettings) {
    elements.viewSettings.classList.toggle('active', viewName === 'settings');
  }

  if (viewName === 'inbox') {
    loadContents();
  } else if (viewName === 'triage') {
    loadProjects();
    loadSuggestions();
  } else if (viewName === 'consultant') {
    const consultantInput = document.getElementById('consultant-query-input');
    consultantInput?.focus();
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
  const form = document.getElementById('consultant-query-form');
  const input = document.getElementById('consultant-query-input');
  const btnSubmit = document.getElementById('btn-submit-consultant');
  const btnText = document.getElementById('consultant-btn-text');
  const spinner = document.getElementById('consultant-spinner');
  const resultsBox = document.getElementById('consultant-results-box');

  if (!form || !input || !resultsBox) return;

  const initialGuideHtml = resultsBox.innerHTML;

  // Wire up clickable example chips
  document.querySelectorAll('.consultant-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const presetQuery = chip.getAttribute('data-query');
      if (presetQuery) {
        input.value = presetQuery;
        form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    btnSubmit.disabled = true;
    if (btnText) btnText.textContent = 'Consultando...';
    spinner.style.display = 'inline-block';

    resultsBox.innerHTML = `
      <div class="consultant-loading-state">
        <span class="spinner"></span>
        <span>Revisando catálogo de lecturas y notas en el Vault...</span>
      </div>
    `;

    try {
      const res = await fetch('/api/library/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Error al consultar tu archivo');

      const formatCitations = (escapedText) =>
        escapedText.replace(/\[([CN]\d+(?:\s*,\s*[CN]\d+)*)\]/gi, (match, groupStr) => {
          return groupStr
            .split(/\s*,\s*/)
            .map(refTag => {
              const upperRef = refTag.trim().toUpperCase();
              const isNote = upperRef.startsWith('N');
              return `<a href="#consult-ref-${upperRef}" class="consult-ref-badge ${isNote ? 'note-ref' : 'content-ref'}" data-ref="${upperRef}" title="Ir a referencia [${upperRef}]">[${upperRef}]</a>`;
            })
            .join(' ');
        });

      const formattedDiagnosis = formatCitations(escapeHtml(data.diagnosis || ''))
        .split(/\n\n+/)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('');

      const viabilityHtml = data.projectViability
        ? `
          <div class="consultant-viability-box">
            <strong class="viability-heading">Enfoque de proyecto sugerido</strong>
            <p class="viability-text">${formatCitations(escapeHtml(data.projectViability))}</p>
          </div>
        `
        : '';

      const matchedContents = Array.isArray(data.matchedContents) ? data.matchedContents : [];
      const matchedNotes = Array.isArray(data.matchedNotes) ? data.matchedNotes : [];

      const contentsColumnHtml = matchedContents.length > 0
        ? `
          <div class="consultant-matches-list">
            ${matchedContents.map(item => {
              const isYoutube = (item.sourceType === 'youtube') || /youtube\.com|youtu\.be/i.test(item.uri || '');
              const typeLabel = isYoutube ? 'Video' : 'Artículo';
              return `
                <article class="consultant-match-card content-match" id="consult-ref-${escapeHtml(item.refId)}">
                  <div class="match-card-top">
                    <div class="match-card-badges">
                      <span class="consult-ref-pill content-ref">[${escapeHtml(item.refId)}]</span>
                      <span class="match-meta-text">${escapeHtml(item.channelOrDomain || typeLabel)}</span>
                    </div>
                    <div class="match-card-actions">
                      <button type="button" class="btn-text-action btn-view-library-detail" data-id="${escapeHtml(item.id)}">Ver ficha</button>
                      <a href="${escapeHtml(item.uri)}" target="_blank" rel="noopener" class="source-link">Abrir original ↗</a>
                    </div>
                  </div>
                  <h4 class="match-card-title">${escapeHtml(item.title || item.uri)}</h4>
                  <p class="why-connects-text">${escapeHtml(item.whyItConnects)}</p>
                </article>
              `;
            }).join('')}
          </div>
        `
        : `
          <p class="consultant-empty-column">Ningún video o artículo guardado aborda directamente esta consulta.</p>
        `;

      const notesColumnHtml = matchedNotes.length > 0
        ? `
          <div class="consultant-matches-list">
            ${matchedNotes.map(note => {
              const snippetText = (note.contentSnippet || '').trim();
              const snippetHtml = snippetText
                ? `
                  <details class="note-snippet-details">
                    <summary>Leer extracto de la nota</summary>
                    <pre class="note-snippet-pre">${escapeHtml(snippetText.substring(0, 700))}${snippetText.length > 700 ? '…' : ''}</pre>
                  </details>
                `
                : '';
              return `
                <article class="consultant-match-card note-match" id="consult-ref-${escapeHtml(note.refId)}">
                  <div class="match-card-top">
                    <div class="match-card-badges">
                      <span class="consult-ref-pill note-ref">[${escapeHtml(note.refId)}]</span>
                      <span class="note-project-badge">${escapeHtml(note.projectTitle)}</span>
                    </div>
                    <code class="note-path-code">${escapeHtml(note.notePath || note.noteTitle)}</code>
                  </div>
                  <h4 class="match-card-title">${escapeHtml(note.noteTitle || note.notePath)}</h4>
                  <p class="why-connects-text">${escapeHtml(note.whyItConnects)}</p>
                  ${snippetHtml}
                </article>
              `;
            }).join('')}
          </div>
        `
        : `
          <p class="consultant-empty-column">Ninguna nota en tu Vault de Obsidian aborda directamente este tema todavía.</p>
        `;

      resultsBox.innerHTML = `
        <div class="consultant-diagnosis-card">
          <div class="consultant-diagnosis-header">
            <h3 class="consultant-diagnosis-title">${escapeHtml(data.query)}</h3>
            <div class="consultant-diagnosis-meta">
              <span class="consultant-eval-stats">
                ${data.totalLibraryEvaluated} lecturas y ${data.totalNotesEvaluated} notas revisadas
              </span>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-clear-consultant-results">Limpiar</button>
            </div>
          </div>

          <div class="consultant-diagnosis-body">
            ${formattedDiagnosis}
          </div>

          ${viabilityHtml}
        </div>

        <div class="consultant-columns">
          <div class="consultant-column-card">
            <div class="consultant-column-header">
              <h3 class="consultant-column-title">En tu biblioteca</h3>
              <span class="consultant-column-count">${matchedContents.length}</span>
            </div>
            ${contentsColumnHtml}
          </div>

          <div class="consultant-column-card">
            <div class="consultant-column-header">
              <h3 class="consultant-column-title">En tus notas de Obsidian</h3>
              <span class="consultant-column-count">${matchedNotes.length}</span>
            </div>
            ${notesColumnHtml}
          </div>
        </div>
      `;

      resultsBox.querySelectorAll('.btn-view-library-detail').forEach(btn => {
        btn.addEventListener('click', () => {
          const cid = btn.getAttribute('data-id');
          if (cid) openContentDetailModal(cid);
        });
      });

      resultsBox.querySelectorAll('.consult-ref-badge').forEach(badge => {
        badge.addEventListener('click', (ev) => {
          ev.preventDefault();
          const ref = badge.getAttribute('data-ref');
          const targetEl = document.getElementById(`consult-ref-${ref}`);
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetEl.classList.add('highlight-pulse');
            setTimeout(() => targetEl.classList.remove('highlight-pulse'), 1800);
          }
        });
      });

      document.getElementById('btn-clear-consultant-results')?.addEventListener('click', () => {
        resultsBox.innerHTML = initialGuideHtml;
      });
    } catch (err) {
      resultsBox.innerHTML = `
        <div class="form-error" style="display: block;">
          ${escapeHtml(err.message || 'Error al consultar la biblioteca y el Vault')}
        </div>
      `;
      showToast(err.message, 'error');
    } finally {
      btnSubmit.disabled = false;
      if (btnText) btnText.textContent = 'Consultar';
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
        <p>No hay contenidos guardados todavía. Pega un enlace arriba para comenzar.</p>
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

    let triageBadgeHtml = '';
    if (item.ingestStatus === 'ready') {
      if (item.isEvaluating) {
        triageBadgeHtml = `<span class="chip chip-neutral"><span class="spinner" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-right:5px;border-width:1.5px;"></span>Evaluando...</span>`;
      } else if (item.counts.actionable > 0) {
        triageBadgeHtml = `<span class="chip chip-actionable">Accionable (${item.counts.actionable})</span>`;
      } else if (item.counts.tentative > 0) {
        triageBadgeHtml = `<span class="chip chip-tentative">Tentativo (${item.counts.tentative})</span>`;
      } else if (item.counts.irrelevant > 0) {
        triageBadgeHtml = `<span class="chip chip-discarded">Sin conexión directa</span>`;
      } else {
        triageBadgeHtml = `<span class="chip chip-neutral">Archivado</span>`;
      }
    } else {
      triageBadgeHtml = `<span class="chip ${item.ingestStatus}">${statusLabel}</span>`;
    }

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
                    ${ev.verdict === 'irrelevant' ? vLabel : `${vLabel} · ${scorePct}%`}
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
                <span class="content-item-author-tag">${escapeHtml(item.channelOrDomain)}</span>
              ` : ''}
              <span class="content-item-uri">${escapeHtml(item.uri)}</span>
            </div>
          </div>
          ${triageBadgeHtml}
        </div>

        ${evaluationsPreviewHtml}

        ${isFailed && item.ingestStatusReason ? `
          <div class="form-error" style="margin: 0.6rem 0; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <strong>Error:</strong> ${escapeHtml(item.ingestStatusReason)}
            </div>
            <button type="button" class="btn btn-secondary btn-sm btn-retry" data-retry-url="${escapeHtml(item.uri)}">
              Reintentar
            </button>
          </div>
        ` : ''}

        <div class="content-item-meta">
          <span class="content-item-meta-item">${dateFormatted}</span>
          <span class="content-item-meta-item">
            ${item.counts.evaluations > 0 
              ? `${item.counts.evaluations} evaluaci${item.counts.evaluations === 1 ? 'ón' : 'ones'} (${item.counts.actionable} accionables, ${item.counts.tentative || 0} tentativas)` 
              : (item.isEvaluating ? 'Evaluando con tus notas...' : (item.ingestStatus !== 'ready' ? (STATUS_LABELS[item.ingestStatus] || item.ingestStatus) : 'Guardado en biblioteca'))}
          </span>
          <button type="button" class="btn btn-secondary btn-sm btn-detail" data-content-id="${item.id}" style="margin-left: auto;">
            Ver ficha
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
  const currentSignature = `${state.selectedProjectId || 'all'}:${state.selectedSuggestionStatus}:${items.map(s => `${s.id}-${s.status}-${s.writtenToVault}-${Boolean(s.isStale)}`).join(',')}`;
  if (currentSignature === state.renderedSuggestionsSignature) {
    // Structure and items haven't changed: do not rebuild DOM to keep disclosure widgets open and inputs focused
    return;
  }
  state.renderedSuggestionsSignature = currentSignature;

  const stalePendingCount = items.filter(s => s.isStale && s.status === 'pending').length;
  if (elements.btnBatchReevaluate && elements.batchReevaluateText) {
    if (stalePendingCount > 0 && state.selectedSuggestionStatus !== 'accepted' && state.selectedSuggestionStatus !== 'discarded') {
      elements.btnBatchReevaluate.style.display = 'inline-flex';
      elements.batchReevaluateText.textContent = `Re-evaluar obsoletas (${stalePendingCount})`;
    } else {
      elements.btnBatchReevaluate.style.display = 'none';
    }
  }

  if (items.length === 0) {
    const statusText = state.selectedSuggestionStatus === 'active'
      ? 'No hay sugerencias activas para este proyecto.'
      : state.selectedSuggestionStatus === 'pending' 
      ? 'No hay sugerencias pendientes de revisión.' 
      : state.selectedSuggestionStatus === 'tentative'
      ? 'No hay evaluaciones tentativas para este proyecto.'
      : state.selectedSuggestionStatus === 'accepted' 
      ? 'Aún no has aceptado ninguna sugerencia para este proyecto.' 
      : 'No hay sugerencias descartadas para este proyecto.';

    elements.suggestionsList.innerHTML = `
      <div class="empty-state">
        <p>${statusText}</p>
      </div>
    `;
    return;
  }

  elements.suggestionsList.innerHTML = items.map((sug) => {
    const isTentative = sug.status === 'tentative';
    const isPending = sug.status === 'pending';
    const isAccepted = sug.status === 'accepted';
    const isDiscarded = sug.status === 'discarded';

    let actionLabel = ACTION_LABELS[sug.actionType] || sug.actionType;
    let chipClass = 'chip-neutral';

    if (isTentative) {
      actionLabel = 'Tentativo';
      chipClass = 'chip-tentative';
    } else if (isDiscarded) {
      actionLabel = sug.targetFile === 'discarded' ? 'Descartado por filtro' : 'Descartado';
      chipClass = 'chip-discarded';
    } else if (isAccepted) {
      actionLabel = 'Aceptada';
      chipClass = 'chip-actionable';
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
      <p style="font-size: 0.86rem; line-height: 1.55; color: var(--text-secondary);">
        ${escapeHtml(sug.triageReasoning)}
      </p>
    ` : (cachedReasoning || `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <span><strong>Nota destino:</strong> <code>${escapeHtml(sug.targetFile)}</code></span>
        <span class="badge ${sug.writtenToVault ? 'badge-accent' : 'badge-subtle'}">
          ${sug.writtenToVault ? 'En Obsidian' : 'Pendiente de Vault'}
        </span>
      </div>
      <p style="font-style: italic;">Cargando justificación...</p>
    `);

    const discardedReasonBox = isDiscarded && sug.triageReasoning ? `
      <div class="discard-reason-box">
        <strong>Motivo del descarte:</strong> ${escapeHtml(sug.triageReasoning)}
      </div>
    ` : '';

    return `
      <div class="glass-card suggestion-card" id="sug-card-${sug.id}" data-id="${sug.id}">
        <div class="suggestion-header">
          <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
            <span class="action-chip ${chipClass}">${actionLabel}</span>
            <span class="suggestion-project-tag">${escapeHtml(sug.projectTitle || 'Proyecto')}</span>
            ${(sug.isStale && isPending) ? `
              <span class="badge badge-stale" title="Las notas del proyecto cambiaron desde esta evaluación.">Notas modificadas</span>
            ` : ''}
          </div>
          <span style="font-size: 0.78rem; color: var(--text-tertiary); font-family: var(--font-mono);">${dateFormatted}</span>
        </div>

        <h4 class="suggestion-action-title">${escapeHtml(sug.suggestedAction)}</h4>
        <p class="suggestion-observation">${escapeHtml(sug.observation)}</p>

        <div class="obsidian-callout-preview ${isAccepted ? 'callout-accepted' : ''}">
          <div class="obsidian-callout-target">
            <span>${isAccepted ? 'Integrado en' : 'Destino sugerido:'}</span>
            <code>${escapeHtml(sug.targetFile && sug.targetFile !== 'discarded' ? sug.targetFile : 'suggestions.md')}</code>
          </div>
          <div class="obsidian-callout-text">
            &ldquo;${escapeHtml(sug.suggestedAction)}&rdquo;
          </div>
        </div>

        ${discardedReasonBox}

        <div class="suggestion-source">
          <span>Fuente:</span>
          <a href="${safeUrl(sug.contentUri)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(sug.contentTitle || sug.contentUri)} ↗
          </a>
        </div>

        <details class="ai-triage-details" ${isOpen ? 'open' : ''}>
          <summary class="ai-triage-summary">
            <span>Ver justificación de la sugerencia</span>
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
                placeholder="${isTentative ? 'Nota opcional al integrar...' : 'Añadir comentario opcional al guardar en Obsidian...'}"
                value="${escapeHtml(draftFeedback)}"
              >
            </div>
            <div class="suggestion-actions">
              ${(sug.isStale && isPending) ? `
                <button type="button" class="btn btn-secondary btn-sm btn-reevaluate" id="btn-reevaluate-${sug.id}" data-id="${sug.id}" title="Re-evaluar con la versión actual de tus notas">
                  Re-evaluar
                </button>
              ` : ''}
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
            <span style="font-size: 0.8rem; color: var(--text-tertiary);">
              ${isAccepted ? 'Integrada en Obsidian' : `Descartada ${sug.targetFile === 'discarded' ? 'automáticamente' : 'manualmente'}`}
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

  // Re-evaluate button handler
  elements.suggestionsList.querySelectorAll('.btn-reevaluate').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      const targetBtn = e.currentTarget;
      targetBtn.disabled = true;
      targetBtn.innerHTML = '↻ Re-evaluando...';

      try {
        const res = await fetch(`/api/suggestions/${id}/reevaluate`, {
          method: 'POST',
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error al re-evaluar la sugerencia');

        if (data.resolution === 'keep_or_refine') {
          showToast('Sugerencia re-evaluada y actualizada.', 'success');
        } else if (data.resolution === 'already_addressed') {
          showToast('Sugerencia marcada como ya abordada en el borrador.', 'info');
        } else if (data.resolution === 'obsolete') {
          showToast('Sugerencia marcada como obsoleta tras cambios en el proyecto.', 'info');
        }

        // Force re-render and reload authoritative state
        state.renderedSuggestionsSignature = '';
        await loadProjects();
        await loadSuggestions();
      } catch (err) {
        showToast(err.message, 'error');
        targetBtn.disabled = false;
        targetBtn.innerHTML = '↻ Re-evaluar';
      }
    });
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
    elements.btnSynthesizeText.textContent = 'Compilar síntesis';
    elements.synthesizeSpinner.style.display = 'none';
  }
}

function openSynthesisResultModal(data, projectTitle) {
  if (!elements.synthesisResultModal) return;

  elements.synthesisModalTitle.textContent = data.title || `Síntesis — ${projectTitle}`;

  const nextStepsHtml = (data.suggestedNextSteps || []).length > 0
    ? `
      <div class="synthesis-section">
        <span class="synthesis-section-title">Próximos pasos sugeridos</span>
        <ul class="synthesis-steps-list">
          ${(data.suggestedNextSteps || []).map(step => `
            <li class="synthesis-step-item">
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
          <span>Guardado en: <code>${escapeHtml(data.filePath)}</code></span>
        </div>
        <span class="chip chip-actionable">${data.acceptedCount} sugerencias integradas</span>
      </div>

      <div class="synthesis-section">
        <span class="synthesis-section-title">Síntesis</span>
        <div class="synthesis-summary-text">${escapeHtml(data.executiveSummary).replace(/\n/g, '<br>')}</div>
      </div>

      ${nextStepsHtml}

      <div class="synthesis-actions-bar">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-synthesis-summary">Copiar texto</button>
        <button type="button" class="btn btn-primary btn-sm" id="btn-confirm-synthesis-modal">Cerrar</button>
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
// Staleness & Batch Re-evaluation (Option C)
// ==========================================================================

function setupBatchReevaluateAction() {
  if (elements.btnBatchReevaluate) {
    elements.btnBatchReevaluate.addEventListener('click', handleBatchReevaluate);
  }
}

async function handleBatchReevaluate() {
  const staleItems = state.suggestions.filter(s => s.isStale && s.status === 'pending');
  if (staleItems.length === 0) {
    showToast('No hay sugerencias desactualizadas en este momento.', 'info');
    return;
  }

  if (elements.btnBatchReevaluate) {
    elements.btnBatchReevaluate.disabled = true;
    if (elements.batchReevaluateSpinner) elements.batchReevaluateSpinner.style.display = 'inline-block';
    if (elements.batchReevaluateText) elements.batchReevaluateText.textContent = 'Re-evaluando...';
  }

  try {
    let reevaluatedCount = 0;
    if (state.selectedProjectId) {
      const res = await fetch(`/api/projects/${state.selectedProjectId}/reevaluate-stale`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Error en la re-evaluación por lotes');
      reevaluatedCount = data.reevaluatedCount || 0;
    } else {
      const projectIds = [...new Set(staleItems.map(s => s.projectId))];
      for (const pid of projectIds) {
        const res = await fetch(`/api/projects/${pid}/reevaluate-stale`, {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Error en la re-evaluación por lotes');
        reevaluatedCount += (data.reevaluatedCount || 0);
      }
    }

    showToast(`Se re-evaluaron ${reevaluatedCount} sugerencias desactualizadas.`, 'success');
    state.renderedSuggestionsSignature = '';
    await loadProjects();
    await loadSuggestions();
  } catch (err) {
    console.error('Batch re-evaluate error:', err);
    showToast(err.message || 'Error al re-evaluar sugerencias.', 'error');
  } finally {
    if (elements.btnBatchReevaluate) {
      elements.btnBatchReevaluate.disabled = false;
      if (elements.batchReevaluateSpinner) elements.batchReevaluateSpinner.style.display = 'none';
    }
  }
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
      showToast(`${state.synergies.length} conexiones calculadas`, 'info');
    }
  } catch (err) {
    console.error('Failed to load synergies:', err);
  }
}

function renderSynergies() {
  if (!elements.synergiesSection || !elements.synergiesGrid) return;

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
    elements.synergiesCountBadge.textContent = `${visibleSynergies.length}`;
  }

  elements.synergiesGrid.innerHTML = visibleSynergies.map(s => {
    const notesHtml = (s.closestNotes && s.closestNotes.length > 0)
      ? `
        <div class="synergy-notes-box">
          <span class="synergy-notes-label">Notas relacionadas</span>
          ${s.closestNotes.slice(0, 2).map(n => `
            <div class="synergy-notes-pair">
              <span class="synergy-note-link" title="${escapeHtml(n.noteAPath)}">${escapeHtml(n.noteATitle)}</span>
              <span class="synergy-arrow">—</span>
              <span class="synergy-note-link" title="${escapeHtml(n.noteBPath)}">${escapeHtml(n.noteBSTitle)}</span>
            </div>
          `).join('')}
        </div>
      `
      : '';

    const hasBridge = Boolean(s.hasExistingBridge);
    const bridgeBadge = hasBridge
      ? `<span class="synergy-cached-badge" title="Este puente ya fue guardado en tu Vault">En Vault</span>`
      : '';
    const btnText = hasBridge ? 'Ver nota puente' : 'Explorar conexión';

    return `
      <div class="synergy-card">
        <div class="synergy-card-header">
          <div class="synergy-proj-bridge">
            <span class="synergy-proj-name" title="${escapeHtml(s.projectA.title)}">${escapeHtml(s.projectA.title)}</span>
            <span class="synergy-arrow">—</span>
            <span class="synergy-proj-name" title="${escapeHtml(s.projectB.title)}">${escapeHtml(s.projectB.title)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
            ${bridgeBadge}
            <span class="synergy-score-chip">${s.similarityScore}%</span>
          </div>
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
            <span>${btnText}</span>
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
      exploreSynergyBridge(pA, pB, tA, tB, false);
    });
  });
}

async function exploreSynergyBridge(projectAId, projectBId, titleA, titleB, forceRegenerate = false) {
  if (!elements.synergyBridgeModal) return;

  elements.synergyModalTitle.textContent = `${titleA} — ${titleB}`;
  elements.synergyModalBody.innerHTML = `
    <div style="text-align: center; padding: 3rem 1.5rem;">
      <span class="spinner large"></span>
      <p style="color: var(--text-secondary); margin-top: 1rem;">
        ${forceRegenerate ? 'Regenerando nota puente...' : 'Cargando conexión entre proyectos...'}
      </p>
    </div>
  `;
  elements.synergyBridgeModal.showModal();

  try {
    const res = await fetch('/api/projects/synergies/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectAId, projectBId, saveToVault: true, forceRegenerate }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Error al generar el puente de sinergia.');
    }

    elements.synergyModalTitle.textContent = data.bridgeTitle;

    const vaultBadge = data.writtenToVault && data.filePath
      ? `<span class="chip chip-actionable">Vault: ${escapeHtml(data.filePath)}</span>`
      : '';

    const cacheIndicator = data.isCached
      ? `<span class="synergy-cached-badge">Guardado en Vault</span>`
      : `<span class="synergy-cached-badge">Recién generado</span>`;

    elements.synergyModalBody.innerHTML = `
      <div class="synthesis-content-view">
        <div class="synthesis-meta-bar">
          <div class="synergy-modal-bridge-titles">
            <span class="synergy-modal-proj-tag" title="${escapeHtml(titleA)}">${escapeHtml(titleA)}</span>
            <span class="synergy-arrow">—</span>
            <span class="synergy-modal-proj-tag" title="${escapeHtml(titleB)}">${escapeHtml(titleB)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${cacheIndicator}
            ${vaultBadge}
          </div>
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">Puntos de contacto</span>
          <div class="synthesis-summary-text">${escapeHtml(data.overview).replace(/\n/g, '<br>')}</div>
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">Preguntas compartidas</span>
          <ul class="synthesis-steps-list">
            ${(data.sharedProblems || []).map(p => `
              <li class="synthesis-step-item">
                <span>${escapeHtml(p)}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">Aportes cruzados</span>
          <ul class="synthesis-steps-list">
            ${(data.mutualBenefits || []).map(b => `
              <li class="synthesis-step-item">
                <span>${escapeHtml(b)}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        ${data.markdownContent ? `
        <div class="synthesis-section">
          <span class="synthesis-section-title">Borrador Markdown</span>
          <pre class="synthesis-markdown-preview"><code>${escapeHtml(data.markdownContent)}</code></pre>
        </div>
        ` : ''}

        <div class="synthesis-actions-bar">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-regenerate-synergy">
            <span>Regenerar</span>
          </button>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-synergy-note">Copiar nota</button>
          <button type="button" class="btn btn-primary btn-sm" id="btn-close-synergy-view">Cerrar</button>
        </div>
      </div>
    `;

    document.getElementById('btn-close-synergy-view')?.addEventListener('click', () => {
      elements.synergyBridgeModal.close();
    });

    document.getElementById('btn-regenerate-synergy')?.addEventListener('click', () => {
      exploreSynergyBridge(projectAId, projectBId, titleA, titleB, true);
    });

    document.getElementById('btn-copy-synergy-note')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`${data.bridgeTitle}\n\n${data.overview}\n\n${data.markdownContent}`);
        showToast('Nota copiada al portapapeles', 'info');
      } catch {
        showToast('No se pudo copiar automáticamente', 'warning');
      }
    });

    if (data.isCached) {
      showToast(`Puente cargado desde el Vault: ${data.filePath}`, 'info');
    } else if (data.writtenToVault && data.filePath) {
      showToast(`Puente guardado en Obsidian: ${data.filePath}`, 'success');
    }

    loadSynergies();
  } catch (err) {
    console.error('Synergy exploration error:', err);
    elements.synergyModalBody.innerHTML = `
      <div style="padding: 2rem 1rem; text-align: center; color: var(--color-danger);">
        <p><strong>Error al explorar conexión:</strong> ${escapeHtml(err.message || 'Error inesperado')}</p>
        <button type="button" class="btn btn-secondary btn-sm" style="margin-top: 1rem;" onclick="document.getElementById('synergy-bridge-modal').close()">Cerrar</button>
      </div>
    `;
  }
}

async function openContentDetailModal(contentIdOrObj) {
  const contentId = (typeof contentIdOrObj === 'object' && contentIdOrObj !== null)
    ? contentIdOrObj.id
    : contentIdOrObj;
  if (!contentId) return;

  elements.modalContentTitle.textContent = 'Cargando...';
  elements.modalContentBody.innerHTML = '<div style="text-align: center; padding: 2.5rem 1rem;"><span class="spinner large"></span></div>';
  elements.contentDetailModal.showModal();

  try {
    const res = await fetch(`/api/contents/${contentId}`);
    if (!res.ok) throw new Error('No se pudo obtener el detalle');
    const data = await res.json();

    let displayTitle = data.title || 'Ficha de contenido';
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
              ${ev.verdict === 'irrelevant' ? vLabel : `${vLabel} · ${scorePct}%`}
            </span>
          </div>
          <p class="modal-eval-reasoning">${escapeHtml(ev.triageReasoning || 'Sin justificación disponible.')}</p>
        </div>
      `;
    }).join('') : `
      <p class="modal-empty-notice">Sin evaluaciones directas en los proyectos actuales.</p>
    `;

    elements.modalContentBody.innerHTML = `
      <div class="modal-section">
        <span class="modal-section-label">Fuente original</span>
        <div class="modal-source-row">
          ${data.channelOrDomain ? `
            <span class="content-item-author-tag">${escapeHtml(data.channelOrDomain)}</span>
          ` : ''}
          <a href="${safeUrl(data.uri)}" target="_blank" rel="noopener noreferrer" class="modal-uri-link">
            ${escapeHtml(data.uri)} ↗
          </a>
        </div>
      </div>

      <div class="modal-section">
        <span class="modal-section-label">Resumen</span>
        <div class="modal-summary-box">
          <p>${escapeHtml(data.summary || 'Aún no se ha generado el resumen del contenido.')}</p>
        </div>
      </div>

      <div class="modal-section">
        <span class="modal-section-label">Evaluación por proyecto</span>
        ${evalsList}
      </div>
    `;
  } catch (err) {
    elements.modalContentBody.innerHTML = `
      <div class="modal-error-box">
        <p style="color: var(--color-danger); font-weight: 600;">Error al cargar ficha:</p>
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
