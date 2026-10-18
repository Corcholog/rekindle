// Label review page. All text from articles, notes and models is inserted with textContent,
// never as HTML, so nothing in the data can run as script.
const VERDICTS = ['actionable', 'tentative', 'irrelevant'];
const VERDICT_TEXT = { actionable: 'Accionable', tentative: 'Tentativo', irrelevant: 'Irrelevante' };

const state = { data: null, initialMetrics: null, selected: null, filter: 'all', query: '', savedTimer: null };

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const pct = n => (n === null || n === undefined ? 'n/d' : `${Math.round(n * 100)}%`);
const fixed = n => (n === null || n === undefined ? 'n/d' : n.toFixed(2));

function labelCase(articleId) {
  return state.data.labels.cases.find(c => c.article === articleId);
}
function explicitVerdict(articleId, project) {
  return labelCase(articleId)?.projects?.[project]?.verdict ?? null;
}
function effectiveVerdict(articleId, project) {
  return explicitVerdict(articleId, project) ?? labelCase(articleId)?.others ?? null;
}
function modelVerdict(run, articleId, project) {
  return run.articles[articleId]?.pairs?.[project]?.verdict ?? null; // null = not evaluated
}
const modelOrIrrelevant = (run, articleId, project) => modelVerdict(run, articleId, project) ?? 'irrelevant';

function runNames() {
  return Object.keys(state.data.runs).sort();
}

function articleStats(articleId) {
  let disagreements = 0;
  let split = false;
  for (const project of state.data.projects) {
    const expected = effectiveVerdict(articleId, project.folder);
    const answers = runNames().map(name => modelOrIrrelevant(state.data.runs[name], articleId, project.folder));
    if (expected !== null && answers.some(a => a !== expected)) disagreements++;
    if (new Set(answers).size > 1) split = true;
  }
  return { disagreements, split };
}

function setSaveState(text, isError = false) {
  const el = document.getElementById('save-state');
  el.textContent = text;
  el.classList.toggle('error', isError);
  clearTimeout(state.savedTimer);
  if (!isError && text) state.savedTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

async function sendUpdate(update) {
  setSaveState('Guardando…');
  try {
    const res = await fetch('/api/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'No se pudo guardar');
    const cases = state.data.labels.cases;
    const index = cases.findIndex(c => c.article === body.case.article);
    if (index === -1) cases.push(body.case); else cases[index] = body.case;
    state.data.metrics = body.metrics;
    setSaveState('Guardado en labels.yaml ✓');
    renderMetrics();
    renderList();
    renderDetail();
  } catch (err) {
    setSaveState(`No se guardó: ${err.message}`, true);
  }
}

function renderMetrics() {
  const container = document.getElementById('metrics');
  container.replaceChildren();
  const rows = [
    ['F1 macro', m => m.triage.macroF1, fixed, true],
    ['Accionable: precisión', m => m.triage.perClass.actionable.precision, pct, true],
    ['Accionable: exhaustividad', m => m.triage.perClass.actionable.recall, pct, true],
    ['Irrelevante marcado accionable', m => m.triage.confusion.irrelevant.actionable, String, false],
    ['Nota destino acertada', m => m.triage.targetNoteAccuracy, pct, true],
  ];
  for (const name of runNames()) {
    const now = state.data.metrics[name];
    const before = state.initialMetrics[name];
    const dl = h('dl');
    for (const [label, pick, format, higherIsBetter] of rows) {
      const value = pick(now);
      const old = pick(before);
      let delta = null;
      if (typeof value === 'number' && typeof old === 'number' && Math.abs(value - old) > 1e-9) {
        const diff = value - old;
        const good = higherIsBetter ? diff > 0 : diff < 0;
        const shown = format === pct ? `${diff > 0 ? '+' : ''}${Math.round(diff * 100)} pp` : `${diff > 0 ? '+' : ''}${format === fixed ? diff.toFixed(2) : diff}`;
        delta = h('span', { class: `delta ${good ? 'up' : 'down'}`, title: 'Cambio desde que abriste la página', text: shown });
      }
      dl.append(h('dt', { text: label }), h('dd', {}, format(value), delta));
    }
    container.append(h('article', { class: 'metric-card' },
      h('h2', { text: name }),
      dl,
      h('p', { class: 'muted', text: `${now.cases} artículos · ${now.labeledPairs} pares etiquetados` }),
    ));
  }
}

function visibleArticles() {
  const query = state.query.trim().toLowerCase();
  return state.data.articles.filter(article => {
    if (query && !`${article.id} ${article.title}`.toLowerCase().includes(query)) return false;
    const stats = articleStats(article.id);
    if (state.filter === 'disagree') return stats.disagreements > 0;
    if (state.filter === 'split') return stats.split;
    return true;
  });
}

function renderList() {
  const list = document.getElementById('article-list');
  list.replaceChildren();
  const articles = visibleArticles();
  for (const article of articles) {
    const stats = articleStats(article.id);
    list.append(h('li', {},
      h('button', {
        type: 'button',
        'aria-current': state.selected === article.id ? 'true' : 'false',
        onclick: () => { state.selected = article.id; renderList(); renderDetail(); document.getElementById('detail').focus(); },
      },
        h('span', { class: 'article-title', text: article.title }),
        h('span', { class: 'article-meta' },
          h('span', { class: 'chip source', text: article.id }),
          stats.disagreements > 0 ? h('span', { class: 'chip bad', text: `${stats.disagreements} desacuerdo${stats.disagreements === 1 ? '' : 's'}` }) : h('span', { class: 'chip good', text: 'coinciden' }),
          stats.split ? h('span', { class: 'chip warn', text: 'modelos divididos' }) : null,
        ),
      ),
    ));
  }
  if (articles.length === 0) list.append(h('li', { class: 'empty', text: 'Ningún artículo con este filtro.' }));
}

function interest(articleId, project) {
  let score = 0;
  const label = effectiveVerdict(articleId, project.folder);
  if (label && label !== 'irrelevant') score += 3;
  if (runNames().some(name => modelOrIrrelevant(state.data.runs[name], articleId, project.folder) !== 'irrelevant')) score += 2;
  return score;
}

function verdictChip(verdict) {
  return verdict ? h('span', { class: `chip ${verdict}`, text: VERDICT_TEXT[verdict] }) : h('span', { class: 'chip none', text: 'sin etiqueta' });
}

function renderAnswer(name, run, articleId, project, label) {
  const pair = run.articles[articleId]?.pairs?.[project.folder];
  const verdict = pair?.verdict ?? null;
  const shown = verdict ?? 'irrelevant';
  const verdictClass = label === null ? '' : shown === label ? 'agrees' : 'differs';
  const body = [];
  if (!pair) {
    body.push(h('p', { class: 'empty', text: 'No evaluado: el proyecto no pasó el filtro de distancia, cuenta como irrelevante.' }));
  } else {
    body.push(h('p', { class: 'reason', text: pair.reasoning || '(sin razonamiento)' }));
    if (pair.action) {
      const wanted = labelCase(articleId)?.projects?.[project.folder]?.target_note;
      const sameNote = wanted ? wanted.replace(/\.md$/i, '').split('/').pop().toLowerCase() === pair.action.targetFile.replace(/\.md$/i, '').split('/').pop().toLowerCase() : null;
      body.push(h('div', { class: 'action-box' },
        h('div', {}, h('strong', { text: 'Acción: ' }), pair.action.suggestedAction),
        h('div', {}, h('strong', { text: 'Observación: ' }), pair.action.observation),
        h('div', {}, h('strong', { text: 'Nota destino: ' }), pair.action.targetFile, ' ',
          sameNote === null ? null : h('span', { class: `chip ${sameNote ? 'good' : 'bad'}`, text: sameNote ? 'coincide con tu nota' : 'distinta de la tuya' })),
      ));
    }
  }
  return h('div', { class: `answer ${verdictClass}` },
    h('h4', {}, name, verdictChip(verdict ?? 'irrelevant'), pair && pair.confidence !== null ? h('span', { class: 'muted', text: `${Math.round(pair.confidence * 100)}%` }) : null,
      label !== null ? h('span', { class: `chip ${shown === label ? 'good' : 'bad'}`, text: shown === label ? 'coincide' : 'difiere' }) : null),
    body,
  );
}

function renderProject(article, project) {
  const explicit = explicitVerdict(article.id, project.folder);
  const label = effectiveVerdict(article.id, project.folder);
  const entry = labelCase(article.id)?.projects?.[project.folder];
  const anyDiffers = label !== null && runNames().some(name => modelOrIrrelevant(state.data.runs[name], article.id, project.folder) !== label);

  const retrieval = (state.data.runs[runNames()[0]]?.articles[article.id]?.retrieval ?? []);
  const rank = retrieval.findIndex(r => r.project === project.folder);
  const retrievalText = rank === -1 ? 'No recuperado' : `Recuperado #${rank + 1} · distancia ${retrieval[rank].distance.toFixed(2)}${retrieval[rank].note ? ` · nota ${retrieval[rank].note}` : ''}`;

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': `Tu etiqueta para ${project.folder}` },
    VERDICTS.map(verdict => h('button', {
      type: 'button',
      'aria-pressed': String(explicit === verdict),
      onclick: () => sendUpdate({ article: article.id, project: project.folder, verdict }),
      text: VERDICT_TEXT[verdict],
    })));

  const clear = explicit !== null ? h('button', { type: 'button', class: 'btn', title: 'Quitar mi etiqueta explícita y heredar "resto de proyectos"', onclick: () => sendUpdate({ article: article.id, project: project.folder, verdict: null }), text: 'Heredar' }) : null;

  let noteSelect = null;
  if (explicit === 'actionable') {
    noteSelect = h('label', { class: 'muted' }, 'Nota destino: ',
      h('select', { onchange: event => sendUpdate({ article: article.id, project: project.folder, target_note: event.target.value || null }) },
        h('option', { value: '', text: '— sin indicar —' }),
        project.notes.map(note => h('option', { value: note, text: note, selected: entry?.target_note === note }))));
  }

  return h('section', { class: `project ${anyDiffers ? 'disagree' : ''}` },
    h('div', { class: 'project-head' }, h('h3', { text: project.folder.replace(/^(Projects|Proyectos)\//, '') }), h('span', { class: 'muted', text: retrievalText })),
    h('div', { class: 'label-row' }, h('span', { class: 'muted', text: 'Tu etiqueta:' }), seg, clear,
      explicit === null ? h('span', { class: 'inherit-note', text: label ? `heredada del resto: ${VERDICT_TEXT[label]}` : 'sin etiqueta' }) : null,
      noteSelect),
    h('div', { class: 'answers' }, runNames().map(name => renderAnswer(name, state.data.runs[name], article.id, project, label))),
  );
}

async function loadFullText(article, body, button) {
  button.disabled = true;
  button.textContent = 'Cargando…';
  const res = await fetch(`/api/article?id=${encodeURIComponent(article.id)}`);
  body.textContent = (await res.json()).text;
  button.remove();
}

function renderDetail() {
  const detail = document.getElementById('detail');
  detail.replaceChildren();
  const article = state.data.articles.find(a => a.id === state.selected);
  if (!article) {
    detail.append(h('p', { class: 'empty', text: 'Elige un artículo de la lista.' }));
    return;
  }

  const shown = visibleArticles().map(a => a.id);
  const position = shown.indexOf(article.id);
  const go = offset => () => { state.selected = shown[position + offset]; renderList(); renderDetail(); window.scrollTo({ top: 0 }); };

  const firstRun = state.data.runs[runNames()[0]];
  const summary = firstRun?.articles[article.id]?.summary;
  const textBody = h('div', { class: 'body', text: article.excerpt + (article.length > article.excerpt.length ? '…' : '') });
  const moreButton = article.length > article.excerpt.length
    ? h('button', { type: 'button', class: 'btn', text: `Cargar el texto completo (${article.length.toLocaleString('es')} caracteres)`, onclick: event => loadFullText(article, textBody, event.currentTarget) })
    : null;

  const sorted = [...state.data.projects].sort((a, b) => interest(article.id, b) - interest(article.id, a) || a.folder.localeCompare(b.folder));
  const important = sorted.filter(p => interest(article.id, p) >= 2);
  const rest = sorted.filter(p => interest(article.id, p) < 2);

  const othersSelect = h('select', { 'aria-label': 'Veredicto para los proyectos en blanco', onchange: event => sendUpdate({ article: article.id, others: event.target.value || null }) },
    h('option', { value: '', text: '— ninguno —' }),
    VERDICTS.map(v => h('option', { value: v, text: VERDICT_TEXT[v], selected: labelCase(article.id)?.others === v })));

  detail.append(
    h('div', { class: 'detail-head' },
      h('div', {}, h('h2', { text: article.title }),
        h('p', { class: 'muted' }, article.id, ' · ', article.source === 'real' ? 'real' : 'sintético', article.url ? [' · ', h('a', { href: article.url, target: '_blank', rel: 'noopener noreferrer', text: 'abrir original' })] : null)),
      h('div', { class: 'nav-buttons' },
        h('button', { type: 'button', text: '← Anterior', disabled: position <= 0, onclick: go(-1) }),
        h('button', { type: 'button', text: 'Siguiente →', disabled: position === -1 || position >= shown.length - 1, onclick: go(1) })),
    ),
    summary ? h('details', { class: 'block', open: true }, h('summary', { text: 'Resumen que vieron los modelos' }), h('div', { class: 'body', text: summary })) : null,
    h('details', { class: 'block' }, h('summary', { text: 'Texto del artículo' }), textBody, moreButton),
    h('div', { class: 'others-row' }, h('span', { text: 'Resto de proyectos (los que dejes en blanco):' }), othersSelect),
    h('div', { class: 'projects' }, important.map(p => renderProject(article, p))),
    rest.length > 0 ? h('details', { class: 'rest' }, h('summary', { text: `Otros ${rest.length} proyectos (irrelevantes para ti y para los modelos)` }),
      h('div', { class: 'projects' }, rest.map(p => renderProject(article, p)))) : null,
  );
}

async function start() {
  const res = await fetch('/api/data');
  state.data = await res.json();
  state.initialMetrics = structuredClone(state.data.metrics);
  document.getElementById('subtitle').textContent =
    `Dataset «${state.data.dataset}» · etiquetas de ${state.data.labels.labeled_by ?? 'nadie todavía'} · ${state.data.articles.length} artículos · cada cambio se guarda en labels.yaml (con copia de seguridad)`;

  for (const button of document.querySelectorAll('.filters button')) {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      for (const other of document.querySelectorAll('.filters button')) other.setAttribute('aria-checked', String(other === button));
      renderList();
    });
  }
  document.getElementById('search').addEventListener('input', event => { state.query = event.target.value; renderList(); });

  state.selected = state.data.articles[0]?.id ?? null;
  renderMetrics();
  renderList();
  renderDetail();
}

start().catch(err => { document.getElementById('subtitle').textContent = `Error al cargar: ${err.message}`; });
