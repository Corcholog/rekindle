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
  setupTriageStatusTabs();
  setupSettingsView();
  setupModalEvents();
  setupSystemStatusPoller();

  // Initial Data Load
  loadVaultSettings();
  loadContents();
  loadProjects();
  loadSuggestions();
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

function setupSystemStatusPoller() {
  const checkStatus = async () => {
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
    }
  };

  checkStatus();
  setInterval(checkStatus, 2500);
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

function checkInFlightPolling(items) {
  const inFlightCount = items.filter(i => ['pending', 'extracting', 'summarizing', 'embedding'].includes(i.ingestStatus) || i.isEvaluating).length;

  if (inFlightCount > 0) {
    elements.inboxActiveCount.textContent = inFlightCount;
    elements.inboxActiveCount.style.display = 'inline-block';

    if (!state.inFlightPollingTimer) {
      state.inFlightPollingTimer = setInterval(async () => {
        const prevReadyCount = state.contents.filter(i => i.ingestStatus === 'ready').length;
        await loadContents();
        const newReadyCount = state.contents.filter(i => i.ingestStatus === 'ready').length;
        if (newReadyCount !== prevReadyCount) {
          await loadProjects();
          await loadSuggestions();
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
  } else {
    const proj = state.projects.find(p => p.id === projectId);
    if (proj) {
      elements.selectedProjectTitle.textContent = proj.title;
      elements.selectedProjectThesis.textContent = proj.thesisText || 'Sin tesis definida.';
    }
  }

  updateAllCountsAndBadges();
  loadSuggestions();
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
