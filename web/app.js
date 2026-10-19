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

// UI strings live in i18n.js (Spanish and English), loaded before this module
const i18n = window.LoomI18n;
const t = i18n.t;

const ACTION_TYPES = ['evidence_citation', 'counter_argument', 'unblocker', 'narrative_bridge', 'other'];
const INGEST_STATUSES = ['ready', 'pending', 'extracting', 'summarizing', 'embedding', 'failed'];
const actionLabel = (type) => (ACTION_TYPES.includes(type) ? t(`action.${type}`) : type);
const statusLabel = (status) => (INGEST_STATUSES.includes(status) ? t(`ingestStatus.${status}`) : status);
const verdictLabel = (verdict) => t(`verdict.${verdict === 'actionable' || verdict === 'tentative' ? verdict : 'irrelevant'}`);

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

document.addEventListener('DOMContentLoaded', async () => {
  await i18n.init();
  setupNavigation();
  setupIngestionForm();
  setupExtensionGuide();
  setupLibrarySearchAndAsk();
  setupTriageStatusTabs();
  setupSettingsView();
  setupModalEvents();
  setupSynthesisAction();
  setupBatchReevaluateAction();
  setupSynergies();
  setupSystemStatusPoller();
  setupLanguageSettings();

  // Initial Data Load
  loadVaultSettings();
  loadContents();
  loadProjects();
  loadSuggestions();
  loadSynergies();

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
          elements.liveIndicator.title = t('status.processingTitle');
        }
        if (elements.liveText) {
          elements.liveText.textContent = data.evaluatingJobs > 0 ? t('status.evaluating', { n: data.evaluatingJobs }) : t('status.ingesting');
        }
        if (headerStatus) {
          headerStatus.classList.add('processing');
        }
        wasProcessing = true;
      } else {
        if (elements.liveIndicator) {
          elements.liveIndicator.className = 'status-indicator live';
          elements.liveIndicator.title = t('status.liveTitle');
        }
        if (elements.liveText) {
          elements.liveText.textContent = t('status.connected');
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
        throw new Error(i18n.apiError(data, 'error.ingest'));
      }

      elements.urlInput.value = '';
      // 202 = new URL queued; 200 = already in the library (or a failed one retried)
      if (res.status === 202) {
        showToast(t('inbox.queued'), 'success');
      } else {
        showToast(data.status === 'pending' ? t('inbox.retrying') : t('inbox.alreadyInLibrary'), 'info');
      }
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

function setupExtensionGuide() {
  const btnShowExtensionGuide = document.getElementById('btn-show-extension-guide');
  const extensionGuideModal = document.getElementById('extension-guide-modal');
  const btnCloseExtensionModal = document.getElementById('btn-close-extension-modal');

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
    if (btnText) btnText.textContent = t('consult.submitting');
    spinner.style.display = 'inline-block';

    resultsBox.innerHTML = `
      <div class="consultant-loading-state">
        <span class="spinner"></span>
        <span>${t('consult.reviewing')}</span>
      </div>
    `;

    try {
      const res = await fetch('/api/library/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(i18n.apiError(data, 'error.consult'));

      const formatCitations = (escapedText) =>
        escapedText.replace(/\[([CN]\d+(?:\s*,\s*[CN]\d+)*)\]/gi, (match, groupStr) => {
          return groupStr
            .split(/\s*,\s*/)
            .map(refTag => {
              const upperRef = refTag.trim().toUpperCase();
              const isNote = upperRef.startsWith('N');
              return `<a href="#consult-ref-${upperRef}" class="consult-ref-badge ${isNote ? 'note-ref' : 'content-ref'}" data-ref="${upperRef}" title="${escapeHtml(t('consult.goToRef', { ref: upperRef }))}">[${upperRef}]</a>`;
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
            <strong class="viability-heading">${t('consult.suggestedProject')}</strong>
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
              const isYoutube = /youtube\.com|youtu\.be/i.test(item.uri || '');
              const typeLabel = isYoutube ? t('consult.video') : t('consult.article');
              return `
                <article class="consultant-match-card content-match" id="consult-ref-${escapeHtml(item.refId)}">
                  <div class="match-card-top">
                    <div class="match-card-badges">
                      <span class="consult-ref-pill content-ref">[${escapeHtml(item.refId)}]</span>
                      <span class="match-meta-text">${escapeHtml(item.channelOrDomain || typeLabel)}</span>
                    </div>
                    <div class="match-card-actions">
                      <button type="button" class="btn-text-action btn-view-library-detail" data-id="${escapeHtml(item.id)}">${t('feed.details')}</button>
                      <a href="${safeUrl(item.uri)}" target="_blank" rel="noopener" class="source-link">${t('consult.openOriginal')}</a>
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
          <p class="consultant-empty-column">${t('consult.noContents')}</p>
        `;

      const notesColumnHtml = matchedNotes.length > 0
        ? `
          <div class="consultant-matches-list">
            ${matchedNotes.map(note => {
              const snippetText = (note.contentSnippet || '').trim();
              const snippetHtml = snippetText
                ? `
                  <details class="note-snippet-details">
                    <summary>${t('consult.readSnippet')}</summary>
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
          <p class="consultant-empty-column">${t('consult.noNotes')}</p>
        `;

      resultsBox.innerHTML = `
        <div class="consultant-diagnosis-card">
          <div class="consultant-diagnosis-header">
            <h3 class="consultant-diagnosis-title">${escapeHtml(data.query)}</h3>
            <div class="consultant-diagnosis-meta">
              <span class="consultant-eval-stats">
                ${t('consult.reviewed', { library: data.totalLibraryEvaluated, notes: data.totalNotesEvaluated })}
              </span>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-clear-consultant-results">${t('consult.clear')}</button>
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
              <h3 class="consultant-column-title">${t('consult.inLibrary')}</h3>
              <span class="consultant-column-count">${matchedContents.length}</span>
            </div>
            ${contentsColumnHtml}
          </div>

          <div class="consultant-column-card">
            <div class="consultant-column-header">
              <h3 class="consultant-column-title">${t('consult.inNotes')}</h3>
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
          ${escapeHtml(err.message || t('error.consult'))}
        </div>
      `;
      showToast(err.message, 'error');
    } finally {
      btnSubmit.disabled = false;
      if (btnText) btnText.textContent = t('consult.submit');
      spinner.style.display = 'none';
    }
  });
}

async function loadContents() {
  try {
    const status = elements.filterStatus.value;
    const query = status ? `?status=${encodeURIComponent(status)}&limit=50` : '?limit=50';
    const res = await fetch(`/api/contents${query}`);
    if (!res.ok) throw new Error(t('error.contents'));

    const data = await res.json();
    state.contents = data.items;
    elements.feedCount.textContent = t('feed.count', { n: data.total });

    renderContentsList(data.items);
    checkInFlightPolling(data.items);
  } catch (err) {
    elements.contentsList.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--color-danger);">${escapeHtml(t('feed.loadError', { message: err.message }))}</p>
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
        <p>${t('feed.empty')}</p>
      </div>
    `;
    return;
  }

  elements.contentsList.innerHTML = items.map(item => {
    const ingestLabel = statusLabel(item.ingestStatus);
    const isFailed = item.ingestStatus === 'failed';
    const dateFormatted = new Date(item.consumedAt).toLocaleString(i18n.locale(), {
      dateStyle: 'short',
      timeStyle: 'short',
    });

    let displayTitle = item.title || t('feed.extractingTitle');
    if (item.channelOrDomain && !displayTitle.toLowerCase().includes(item.channelOrDomain.toLowerCase())) {
      displayTitle = `${displayTitle} — ${item.channelOrDomain}`;
    }

    let triageBadgeHtml = '';
    if (item.ingestStatus === 'ready') {
      if (item.isEvaluating) {
        triageBadgeHtml = `<span class="chip chip-neutral"><span class="spinner" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-right:5px;border-width:1.5px;"></span>${t('feed.evaluating')}</span>`;
      } else if (item.counts.actionable > 0) {
        triageBadgeHtml = `<span class="chip chip-actionable">${t('verdict.actionable')} (${item.counts.actionable})</span>`;
      } else if (item.counts.tentative > 0) {
        triageBadgeHtml = `<span class="chip chip-tentative">${t('verdict.tentative')} (${item.counts.tentative})</span>`;
      } else if (item.counts.irrelevant > 0) {
        triageBadgeHtml = `<span class="chip chip-discarded">${t('feed.noConnection')}</span>`;
      } else {
        triageBadgeHtml = `<span class="chip chip-neutral">${t('feed.archived')}</span>`;
      }
    } else {
      triageBadgeHtml = `<span class="chip ${item.ingestStatus}">${ingestLabel}</span>`;
    }

    const evalsList = item.evaluationsList || [];
    let evaluationsPreviewHtml = '';
    if (evalsList.length > 0) {
      evaluationsPreviewHtml = `
        <div class="content-evaluations-preview">
          ${evalsList.map(ev => {
            const vLabel = verdictLabel(ev.verdict);
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
              <strong>${t('ingestStatus.failed')}:</strong> ${escapeHtml(item.ingestStatusReason)}
            </div>
            <button type="button" class="btn btn-secondary btn-sm btn-retry" data-retry-url="${escapeHtml(item.uri)}">
              ${t('feed.retry')}
            </button>
          </div>
        ` : ''}

        <div class="content-item-meta">
          <span class="content-item-meta-item">${dateFormatted}</span>
          <span class="content-item-meta-item">
            ${item.counts.evaluations > 0 
              ? t('feed.evaluations', { n: item.counts.evaluations, actionable: item.counts.actionable, tentative: item.counts.tentative || 0 })
              : (item.isEvaluating ? t('feed.evaluatingNotes') : (item.ingestStatus !== 'ready' ? ingestLabel : t('feed.saved')))}
          </span>
          <button type="button" class="btn btn-secondary btn-sm btn-detail" data-content-id="${item.id}" style="margin-left: auto;">
            ${t('feed.details')}
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
    if (!res.ok) throw new Error(t('error.retry'));
    showToast(t('inbox.retryToast'), 'info');
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
    if (!res.ok) throw new Error('Error loading projects');
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
      <span class="project-item-title">${t('triage.allProjects')}</span>
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
    elements.selectedProjectTitle.textContent = t('triage.allProjects');
    elements.selectedProjectThesis.textContent = t('triage.allProjectsThesis');
    if (elements.projectHeroActions) elements.projectHeroActions.style.display = 'none';
  } else {
    const proj = state.projects.find(p => p.id === projectId);
    if (proj) {
      elements.selectedProjectTitle.textContent = proj.title;
      elements.selectedProjectThesis.textContent = proj.thesisText || t('triage.noThesis');
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
    if (!res.ok) throw new Error(t('error.suggestions'));

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
        <p style="color: var(--color-danger);">${escapeHtml(t('triage.loadError', { message: err.message }))}</p>
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
      elements.batchReevaluateText.textContent = t('triage.batch', { n: stalePendingCount });
    } else {
      elements.btnBatchReevaluate.style.display = 'none';
    }
  }

  if (items.length === 0) {
    const emptyKeys = {
      active: 'triage.emptyActive', pending: 'triage.emptyPending', tentative: 'triage.emptyTentative',
      accepted: 'triage.emptyAccepted', discarded: 'triage.emptyDiscarded',
    };
    const statusText = t(emptyKeys[state.selectedSuggestionStatus] || 'triage.emptyDiscarded');

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

    let chipLabel = actionLabel(sug.actionType);
    let chipClass = 'chip-neutral';

    if (isTentative) {
      chipLabel = t('sug.tentative');
      chipClass = 'chip-tentative';
    } else if (isDiscarded) {
      chipLabel = sug.targetFile === 'discarded' ? t('sug.discardedByFilter') : t('sug.discarded');
      chipClass = 'chip-discarded';
    } else if (isAccepted) {
      chipLabel = t('sug.accepted');
      chipClass = 'chip-actionable';
    }

    const dateFormatted = new Date(sug.createdAt).toLocaleDateString(i18n.locale());
    const isOpen = state.openDetails.has(sug.id);
    const cachedReasoning = state.loadedReasonings.get(sug.id);
    const draftFeedback = state.feedbackDrafts.get(sug.id) || '';

    const percent = Math.round((sug.confidenceScore || 0) * 100);
    const reasoningContent = sug.triageReasoning ? `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem;">
        <span><strong>${t('sug.verdict')}</strong> <code>${escapeHtml(isTentative ? 'tentative' : (isDiscarded ? 'irrelevant' : 'actionable'))}</code></span>
        ${!isDiscarded ? `
          <div class="confidence-meter">
            <span>${t('sug.affinity')} <strong>${percent}%</strong></span>
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
        <span><strong>${t('sug.targetNote')}</strong> <code>${escapeHtml(sug.targetFile)}</code></span>
        <span class="badge ${sug.writtenToVault ? 'badge-accent' : 'badge-subtle'}">
          ${sug.writtenToVault ? t('sug.inObsidian') : t('sug.pendingVault')}
        </span>
      </div>
      <p style="font-style: italic;">${t('sug.loadingReasoning')}</p>
    `);

    const discardedReasonBox = isDiscarded && sug.triageReasoning ? `
      <div class="discard-reason-box">
        <strong>${t('sug.discardReason')}</strong> ${escapeHtml(sug.triageReasoning)}
      </div>
    ` : '';

    return `
      <div class="glass-card suggestion-card" id="sug-card-${sug.id}" data-id="${sug.id}">
        <div class="suggestion-header">
          <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
            <span class="action-chip ${chipClass}">${escapeHtml(chipLabel)}</span>
            <span class="suggestion-project-tag">${escapeHtml(sug.projectTitle || t('sug.project'))}</span>
            ${(sug.isStale && isPending) ? `
              <span class="badge badge-stale" title="${t('sug.staleTitle')}">${t('sug.stale')}</span>
            ` : ''}
          </div>
          <span style="font-size: 0.78rem; color: var(--text-tertiary); font-family: var(--font-mono);">${dateFormatted}</span>
        </div>

        <h4 class="suggestion-action-title">${escapeHtml(sug.suggestedAction)}</h4>
        <p class="suggestion-observation">${escapeHtml(sug.observation)}</p>

        <div class="obsidian-callout-preview ${isAccepted ? 'callout-accepted' : ''}">
          <div class="obsidian-callout-target">
            <span>${isAccepted ? t('sug.integratedIn') : t('sug.suggestedTarget')}</span>
            <code>${escapeHtml(sug.targetFile && sug.targetFile !== 'discarded' ? sug.targetFile : 'suggestions.md')}</code>
          </div>
          <div class="obsidian-callout-text">
            &ldquo;${escapeHtml(sug.suggestedAction)}&rdquo;
          </div>
        </div>

        ${discardedReasonBox}

        <div class="suggestion-source">
          <span>${t('sug.source')}</span>
          <a href="${safeUrl(sug.contentUri)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(sug.contentTitle || sug.contentUri)} ↗
          </a>
        </div>

        <details class="ai-triage-details" ${isOpen ? 'open' : ''}>
          <summary class="ai-triage-summary">
            <span>${t('sug.showReasoning')}</span>
          </summary>
          <div class="ai-triage-content" id="triage-details-${sug.id}">
            ${reasoningContent}
          </div>
        </details>

        ${(isPending || isTentative) ? `
          <div class="suggestion-footer">
            <div class="feedback-input-wrapper">
              <label for="feedback-${sug.id}" class="visually-hidden">${t('sug.feedbackLabel')}</label>
              <input 
                type="text" 
                id="feedback-${sug.id}" 
                class="feedback-input" 
                placeholder="${isTentative ? t('sug.feedbackTentative') : t('sug.feedbackPending')}"
                value="${escapeHtml(draftFeedback)}"
              >
            </div>
            <div class="suggestion-actions">
              <select id="reason-${sug.id}" class="discard-reason" aria-label="${t('sug.reasonAria')}">
                <option value="">${t('sug.reasonPlaceholder')}</option>
                ${DISCARD_REASONS.map(value => `<option value="${value}">${t(`reason.${value}`)}</option>`).join('')}
              </select>
              ${(sug.isStale && isPending) ? `
                <button type="button" class="btn btn-secondary btn-sm btn-reevaluate" id="btn-reevaluate-${sug.id}" data-id="${sug.id}" title="${t('sug.reevaluateTitle')}">
                  ${t('sug.reevaluate')}
                </button>
              ` : ''}
              <button type="button" class="btn btn-danger btn-discard" id="btn-discard-${sug.id}" data-id="${sug.id}">
                ${t('sug.discard')}
              </button>
              <button type="button" class="btn btn-success btn-accept" id="btn-accept-${sug.id}" data-id="${sug.id}">
                ${isTentative ? t('sug.integrate') : t('sug.accept')}
              </button>
            </div>
          </div>
        ` : `
          <div class="suggestion-footer" style="justify-content: flex-end;">
            <span style="font-size: 0.8rem; color: var(--text-tertiary);">
              ${isAccepted ? t('sug.integratedObsidian') : (sug.targetFile === 'discarded' ? t('sug.discardedAuto') : t('sug.discardedManual'))}
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
      targetBtn.textContent = `↻ ${t('sug.reevaluating')}`;

      try {
        const res = await fetch(`/api/suggestions/${id}/reevaluate`, {
          method: 'POST',
        });

        const data = await res.json();
        if (!res.ok) throw new Error(i18n.apiError(data, 'error.reevaluate'));

        if (data.resolution === 'keep_or_refine') {
          showToast(t('sug.keptToast'), 'success');
        } else if (data.resolution === 'already_addressed') {
          showToast(t('sug.addressedToast'), 'info');
        } else if (data.resolution === 'obsolete') {
          showToast(t('sug.obsoleteToast'), 'info');
        }

        // Force re-render and reload authoritative state
        state.renderedSuggestionsSignature = '';
        await loadProjects();
        await loadSuggestions();
      } catch (err) {
        showToast(err.message, 'error');
        targetBtn.disabled = false;
        targetBtn.textContent = `↻ ${t('sug.reevaluate')}`;
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
      const reason = document.getElementById(`reason-${id}`)?.value || undefined;
      resolveSuggestion(id, 'discarded', feedback, reason);
    });
  });
}

async function loadSuggestionReasoning(suggestionId) {
  const container = document.getElementById(`triage-details-${suggestionId}`);
  if (!container) return;

  try {
    const res = await fetch(`/api/suggestions/${suggestionId}`);
    if (!res.ok) throw new Error(t('error.detail'));
    const data = await res.json();

    const percent = Math.round((data.confidenceScore || 0) * 100);

    const html = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem;">
        <span><strong>${t('sug.verdict')}</strong> <code>${escapeHtml(data.triageVerdict || 'actionable')}</code></span>
        ${data.triageVerdict !== 'irrelevant' ? `
          <div class="confidence-meter">
            <span>${t('sug.affinity')} <strong>${percent}%</strong></span>
            <div class="confidence-bar-bg">
              <div class="confidence-bar-fill" style="width: ${percent}%;"></div>
            </div>
          </div>
        ` : ''}
      </div>
      <p style="margin-bottom: 0.5rem;"><strong>${t('sug.modelReasoning')}</strong></p>
      <p style="background: hsla(220, 20%, 10%, 0.5); padding: 0.6rem; border-radius: 6px;">
        ${escapeHtml(data.triageReasoning || t('sug.noReasoning'))}
      </p>
    `;

    state.loadedReasonings.set(suggestionId, html);
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p style="color: var(--color-danger);">${escapeHtml(err.message)}</p>`;
  }
}

// Fixed reasons offered when discarding; the values match DISCARD_REASONS in src/db/schema.ts
// and each has a "reason.<value>" label in i18n.js
const DISCARD_REASONS = ['unrelated', 'obvious', 'wrong_note', 'poorly_worded', 'other'];

async function resolveSuggestion(suggestionId, status, userFeedback = '', discardReason = undefined) {
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
        discardReason,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(i18n.apiError(data, 'error.update'));

    if (status === 'accepted') {
      showToast(t('sug.acceptedToast'), 'success');
    } else {
      showToast(t('sug.discardedToast'), 'info');
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
    showToast(t('synth.pickProject'), 'warning');
    return;
  }

  const proj = state.projects.find(p => p.id === state.selectedProjectId);
  const acceptedCount = proj?.counts?.accepted ?? 0;

  if (acceptedCount === 0) {
    showToast(t('synth.nothing'), 'warning');
    return;
  }

  // Set loading state
  elements.btnSynthesizeProject.disabled = true;
  elements.btnSynthesizeText.textContent = t('triage.synthesizing');
  elements.synthesizeSpinner.style.display = 'inline-block';

  try {
    const res = await fetch(`/api/projects/${state.selectedProjectId}/synthesize`, {
      method: 'POST',
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(i18n.apiError(data, 'error.synthesis'));
    }

    // Generation does not write to the vault; the modal offers an explicit save button
    openSynthesisResultModal(data, proj?.title || t('sug.project'), state.selectedProjectId);
    showToast(t('synth.done'), 'success');
  } catch (err) {
    console.error('Synthesis error:', err);
    showToast(err.message || t('error.synthesis'), 'error');
  } finally {
    elements.btnSynthesizeProject.disabled = false;
    elements.btnSynthesizeText.textContent = t('triage.synthesize');
    elements.synthesizeSpinner.style.display = 'none';
  }
}

function openSynthesisResultModal(data, projectTitle, projectId) {
  if (!elements.synthesisResultModal) return;

  elements.synthesisModalTitle.textContent = data.title || t('synth.title', { project: projectTitle });

  const nextStepsHtml = (data.suggestedNextSteps || []).length > 0
    ? `
      <div class="synthesis-section">
        <span class="synthesis-section-title">${t('synth.nextSteps')}</span>
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
        <div class="synthesis-meta-path" id="synthesis-save-status">
          <span>${t('synth.notSaved')}</span>
        </div>
        <span class="chip chip-actionable">${t('synth.integrated', { n: data.acceptedCount })}</span>
      </div>

      <div class="synthesis-section">
        <span class="synthesis-section-title">${t('synth.summary')}</span>
        <div class="synthesis-summary-text">${escapeHtml(data.executiveSummary).replace(/\n/g, '<br>')}</div>
      </div>

      ${nextStepsHtml}

      <div class="synthesis-actions-bar">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-synthesis-summary">${t('synth.copy')}</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-save-synthesis">${t('synth.save')}</button>
        <button type="button" class="btn btn-primary btn-sm" id="btn-confirm-synthesis-modal">${t('common.close')}</button>
      </div>
    </div>
  `;

  document.getElementById('btn-confirm-synthesis-modal')?.addEventListener('click', () => {
    elements.synthesisResultModal.close();
  });

  document.getElementById('btn-save-synthesis')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const res = await fetch(`/api/projects/${projectId}/synthesis/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: data.title,
          executiveSummary: data.executiveSummary,
          markdownContent: data.markdownContent || '',
          suggestedNextSteps: data.suggestedNextSteps || [],
          acceptedCount: data.acceptedCount || 0,
        }),
      });
      const saved = await res.json();
      if (!res.ok) throw new Error(i18n.apiError(saved, 'error.saveBrief'));
      button.textContent = t('synth.saved');
      document.getElementById('synthesis-save-status').innerHTML = `<span>${t('synth.savedAt')} <code>${escapeHtml(saved.filePath)}</code></span>`;
      showToast(t('synth.savedToast', { path: saved.filePath }), 'success');
    } catch (err) {
      button.disabled = false;
      showToast(err.message || t('error.saveBrief'), 'error');
    }
  });

  document.getElementById('btn-copy-synthesis-summary')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${data.title}\n\n${data.executiveSummary}\n\n${data.markdownContent || ''}`);
      showToast(t('synth.copied'), 'info');
    } catch {
      showToast(t('common.copyFailed'), 'warning');
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
    showToast(t('sug.batchNone'), 'info');
    return;
  }

  if (elements.btnBatchReevaluate) {
    elements.btnBatchReevaluate.disabled = true;
    if (elements.batchReevaluateSpinner) elements.batchReevaluateSpinner.style.display = 'inline-block';
    if (elements.batchReevaluateText) elements.batchReevaluateText.textContent = t('triage.batchRunning');
  }

  try {
    let reevaluatedCount = 0;
    if (state.selectedProjectId) {
      const res = await fetch(`/api/projects/${state.selectedProjectId}/reevaluate-stale`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(i18n.apiError(data, 'error.batch'));
      reevaluatedCount = data.reevaluatedCount || 0;
    } else {
      const projectIds = [...new Set(staleItems.map(s => s.projectId))];
      for (const pid of projectIds) {
        const res = await fetch(`/api/projects/${pid}/reevaluate-stale`, {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(i18n.apiError(data, 'error.batch'));
        reevaluatedCount += (data.reevaluatedCount || 0);
      }
    }

    showToast(t('sug.batchDone', { n: reevaluatedCount }), 'success');
    state.renderedSuggestionsSignature = '';
    await loadProjects();
    await loadSuggestions();
  } catch (err) {
    console.error('Batch re-evaluate error:', err);
    showToast(err.message || t('error.batch'), 'error');
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
      showToast(t('syn.computed', { n: state.synergies.length }), 'info');
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
          <span class="synergy-notes-label">${t('syn.relatedNotes')}</span>
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
      ? `<span class="synergy-cached-badge" title="${t('syn.inVaultTitle')}">${t('syn.inVault')}</span>`
      : '';
    const btnText = hasBridge ? t('syn.viewBridge') : t('syn.explore');

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
        ${forceRegenerate ? t('syn.regenerating') : t('syn.loading')}
      </p>
    </div>
  `;
  elements.synergyBridgeModal.showModal();

  try {
    const res = await fetch('/api/projects/synergies/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectAId, projectBId, forceRegenerate }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(i18n.apiError(data, 'error.synergy'));
    }

    elements.synergyModalTitle.textContent = data.bridgeTitle;

    const vaultBadge = data.writtenToVault && data.filePath
      ? `<span class="chip chip-actionable">Vault: ${escapeHtml(data.filePath)}</span>`
      : '';

    const cacheIndicator = data.isCached
      ? `<span class="synergy-cached-badge">${t('syn.savedInVault')}</span>`
      : `<span class="synergy-cached-badge">${t('syn.fresh')}</span>`;

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
          <span class="synthesis-section-title">${t('syn.contactPoints')}</span>
          <div class="synthesis-summary-text">${escapeHtml(data.overview).replace(/\n/g, '<br>')}</div>
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">${t('syn.sharedQuestions')}</span>
          <ul class="synthesis-steps-list">
            ${(data.sharedProblems || []).map(p => `
              <li class="synthesis-step-item">
                <span>${escapeHtml(p)}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        <div class="synthesis-section">
          <span class="synthesis-section-title">${t('syn.crossBenefits')}</span>
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
          <span class="synthesis-section-title">${t('syn.markdownDraft')}</span>
          <pre class="synthesis-markdown-preview"><code>${escapeHtml(data.markdownContent)}</code></pre>
        </div>
        ` : ''}

        <div class="synthesis-actions-bar">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-regenerate-synergy">
            <span>${t('syn.regenerate')}</span>
          </button>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-synergy-note">${t('syn.copy')}</button>
          ${data.isCached ? '' : `<button type="button" class="btn btn-secondary btn-sm" id="btn-save-synergy-note">${t('syn.save')}</button>`}
          <button type="button" class="btn btn-primary btn-sm" id="btn-close-synergy-view">${t('common.close')}</button>
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
        showToast(t('syn.copied'), 'info');
      } catch {
        showToast(t('common.copyFailed'), 'warning');
      }
    });

    document.getElementById('btn-save-synergy-note')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const saveRes = await fetch('/api/projects/synergies/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectAId,
            projectBId,
            bridgeTitle: data.bridgeTitle,
            overview: data.overview,
            sharedProblems: data.sharedProblems || [],
            mutualBenefits: data.mutualBenefits || [],
            markdownContent: data.markdownContent || '',
          }),
        });
        const saved = await saveRes.json();
        if (!saveRes.ok) throw new Error(i18n.apiError(saved, 'error.saveBridge'));
        button.textContent = t('syn.saved');
        showToast(t('syn.savedToast', { path: saved.filePath }), 'success');
        loadSynergies();
      } catch (saveErr) {
        button.disabled = false;
        showToast(saveErr.message || t('error.saveBridge'), 'error');
      }
    });

    if (data.isCached) {
      showToast(t('syn.cachedToast', { path: data.filePath }), 'info');
    }
  } catch (err) {
    console.error('Synergy exploration error:', err);
    elements.synergyModalBody.innerHTML = `
      <div style="padding: 2rem 1rem; text-align: center; color: var(--color-danger);">
        <p><strong>${t('syn.error')}</strong> ${escapeHtml(err.message || t('error.generic'))}</p>
        <button type="button" class="btn btn-secondary btn-sm" style="margin-top: 1rem;" onclick="document.getElementById('synergy-bridge-modal').close()">${t('common.close')}</button>
      </div>
    `;
  }
}

async function openContentDetailModal(contentIdOrObj) {
  const contentId = (typeof contentIdOrObj === 'object' && contentIdOrObj !== null)
    ? contentIdOrObj.id
    : contentIdOrObj;
  if (!contentId) return;

  elements.modalContentTitle.textContent = t('common.loading');
  elements.modalContentBody.innerHTML = '<div style="text-align: center; padding: 2.5rem 1rem;"><span class="spinner large"></span></div>';
  elements.contentDetailModal.showModal();

  try {
    const res = await fetch(`/api/contents/${contentId}`);
    if (!res.ok) throw new Error(t('error.detail'));
    const data = await res.json();

    let displayTitle = data.title || t('modal.contentTitle');
    if (data.channelOrDomain && !displayTitle.toLowerCase().includes(data.channelOrDomain.toLowerCase())) {
      displayTitle = `${displayTitle} — ${data.channelOrDomain}`;
    }
    elements.modalContentTitle.textContent = displayTitle;

    const evalsList = (data.evaluations || []).length > 0 ? (data.evaluations || []).map(ev => {
      const vLabel = verdictLabel(ev.verdict);
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
          <p class="modal-eval-reasoning">${escapeHtml(ev.triageReasoning || t('sug.noReasoning'))}</p>
        </div>
      `;
    }).join('') : `
      <p class="modal-empty-notice">${t('modal.noEvaluations')}</p>
    `;

    elements.modalContentBody.innerHTML = `
      <div class="modal-section">
        <span class="modal-section-label">${t('modal.source')}</span>
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
        <span class="modal-section-label">${t('modal.summary')}</span>
        <div class="modal-summary-box">
          <p>${escapeHtml(data.summary || t('modal.noSummary'))}</p>
        </div>
      </div>

      <div class="modal-section">
        <span class="modal-section-label">${t('modal.evaluations')}</span>
        ${evalsList}
      </div>
    `;
  } catch (err) {
    elements.modalContentBody.innerHTML = `
      <div class="modal-error-box">
        <p style="color: var(--color-danger); font-weight: 600;">${t('modal.loadError')}</p>
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
      showVaultFeedback(t('settings.enterPath'), 'error');
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
        throw new Error(i18n.apiError(data, 'error.saveVault'));
      }

      showVaultFeedback(t('settings.vaultSaved', { active: data.summary?.activeProjects ?? 0, missing: data.summary?.missingProjects ?? 0 }), 'success');
      showToast(t('settings.vaultSavedToast'), 'success');
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
      if (!res.ok) throw new Error(i18n.apiError(data, 'error.rescan'));
      showToast(t('settings.rescanDone'), 'success');
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
    if (!res.ok) throw new Error('Error loading the vault settings');
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
      elements.liveIndicator.title = t('status.obsidianTitle');
    }
    if (elements.liveText) elements.liveText.textContent = t('status.connected');
  } else {
    if (elements.vaultWarningBanner) elements.vaultWarningBanner.style.display = 'flex';
    if (elements.liveIndicator) {
      elements.liveIndicator.className = 'status-indicator offline';
      elements.liveIndicator.title = t('status.offlineTitle');
    }
    if (elements.liveText) elements.liveText.textContent = t('status.noVault');
  }

  // Settings Hero Form & Status Pill
  if (data.vaultPath && document.activeElement !== elements.vaultPathInput) {
    elements.vaultPathInput.value = data.vaultPath;
  }

  if (isHealthy) {
    elements.settingsStatusPill.className = 'status-pill connected';
    elements.settingsStatusLabel.textContent = t('settings.statusConnected');
  } else if (data.isConfigured && !data.isValid) {
    elements.settingsStatusPill.className = 'status-pill disconnected';
    elements.settingsStatusLabel.textContent = t('settings.statusNotFound');
  } else {
    elements.settingsStatusPill.className = 'status-pill checking';
    elements.settingsStatusLabel.textContent = t('settings.statusNotConfigured');
  }

  // Info Bar
  elements.infoActivePath.textContent = data.vaultPath || t('settings.notConfigured');
  elements.infoWatcherStatus.textContent = data.watcherActive ? t('settings.watcherActive') : t('settings.inactive');
  elements.infoWatcherStatus.style.color = data.watcherActive ? 'var(--color-success)' : 'var(--text-tertiary)';

  if (data.hasProjectsDir) {
    elements.infoProjectsFolder.textContent = t('settings.detected', { dir: data.projectsDirName });
    elements.infoProjectsFolder.style.color = 'var(--color-success)';
  } else {
    elements.infoProjectsFolder.textContent = t('settings.notDetectedHint');
    elements.infoProjectsFolder.style.color = 'var(--color-warning)';
  }

  // Projects Diagnostics Table
  const projectList = data.projects || [];
  elements.settingsProjectsCount.textContent = t('settings.projectsCount', { n: projectList.length });

  if (projectList.length === 0) {
    elements.settingsProjectsWrapper.innerHTML = `
      <div class="empty-state">
        <p>${escapeHtml(data.hasProjectsDir ? t('settings.noProjectsInDir', { dir: data.projectsDirName || 'Projects' }) : t('settings.noProjectsNoVault'))}</p>
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
        <span class="badge badge-subtle">${t('settings.suggestionsCount', { n: p.suggestionsCount })}</span>
      </td>
      <td>
        ${p.existsOnDisk ? `
          <span class="status-chip status-chip-active">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            ${t('settings.onDisk')}
          </span>
        ` : `
          <span class="status-chip status-chip-inactive" title="${t('settings.missingTitle')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            ${t('settings.missing')}
          </span>
        `}
      </td>
    </tr>
  `).join('');

  elements.settingsProjectsWrapper.innerHTML = `
    <table class="settings-projects-table">
      <thead>
        <tr>
          <th>${t('settings.colProject')}</th>
          <th>${t('settings.colFolder')}</th>
          <th>${t('settings.colSuggestions')}</th>
          <th>${t('settings.colDisk')}</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

// ==========================================================================
// Languages: the interface (this browser) and the server's output and notes languages
// ==========================================================================

function setupLanguageSettings() {
  const uiSelect = document.getElementById('ui-language-select');
  const outputSelect = document.getElementById('output-language-select');
  const notesSelect = document.getElementById('notes-language-select');
  if (!uiSelect || !outputSelect || !notesSelect) return;

  uiSelect.value = i18n.getLanguage();
  // Everything rendered so far is in the old language: reload to rebuild it
  uiSelect.addEventListener('change', () => {
    i18n.setLanguage(uiSelect.value);
    window.location.reload();
  });

  fetch('/api/settings/language')
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (!data) return;
      outputSelect.value = data.outputLanguage;
      notesSelect.value = data.notesLanguage;
    })
    .catch(() => {});

  const save = async (body) => {
    try {
      const res = await fetch('/api/settings/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(i18n.apiError(data, 'error.language'));
      outputSelect.value = data.outputLanguage;
      notesSelect.value = data.notesLanguage;
      showToast(t('lang.saved'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
  outputSelect.addEventListener('change', () => save({ outputLanguage: outputSelect.value }));
  notesSelect.addEventListener('change', () => save({ notesLanguage: notesSelect.value }));
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
