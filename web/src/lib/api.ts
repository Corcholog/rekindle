// Typed client for the Rekindle API (src/api/routes). Same origin; the request guard requires
// it. Errors carry the API body so the UI can show a translated message for its code.

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof (body as { message?: unknown })?.message === 'string' ? (body as { message: string }).message : `HTTP ${status}`);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return { status: res.status, data: data as T };
}

const get = async <T>(url: string) => (await request<T>('GET', url)).data;
const send = async <T>(method: string, url: string, body?: unknown) => (await request<T>(method, url, body)).data;

export type Verdict = 'actionable' | 'tentative' | 'irrelevant';
export type IngestStatus = 'pending' | 'extracting' | 'summarizing' | 'embedding' | 'ready' | 'failed';
export type SuggestionStatus = 'active' | 'pending' | 'tentative' | 'accepted' | 'discarded';
export type Language = 'es' | 'en';
export type DiscardReason = 'unrelated' | 'obvious' | 'wrong_note' | 'poorly_worded' | 'other';

export interface ContentItem {
  id: string;
  uri: string;
  title: string | null;
  channelOrDomain?: string | null;
  ingestStatus: IngestStatus;
  ingestStatusReason: string | null;
  consumedAt: string;
  counts: { evaluations: number; actionable: number; tentative: number; irrelevant: number; suggestions: number };
  evaluationsList?: {
    projectId: string; projectTitle: string; verdict: Verdict | null; confidenceScore: number | null; triageReasoning: string | null;
    suggestionStatus: 'pending' | 'accepted' | 'discarded' | null;
  }[];
  isEvaluating?: boolean;
}

export interface ContentDetail extends ContentItem {
  summary: string | null;
  evaluations: { id: string; projectTitle: string; verdict: Verdict | null; confidenceScore: number | null; triageReasoning: string | null }[];
}

export interface Project {
  id: string;
  title: string;
  folderPath: string;
  isActive: boolean;
  thesisText?: string | null;
  counts: { pending: number; accepted: number; discarded: number; tentative?: number; active?: number; total: number };
  notesModifiedAt: string | null;
  idleDays: number | null;
  isDormant: boolean;
}

export interface Suggestion {
  id: string;
  projectId: string;
  projectTitle: string;
  contentId: string;
  contentTitle: string | null;
  contentUri: string;
  actionType: string;
  targetFile: string;
  observation: string;
  suggestedAction: string;
  status: 'pending' | 'tentative' | 'accepted' | 'discarded';
  writtenToVault: boolean;
  createdAt: string;
  confidenceScore?: number | null;
  triageReasoning?: string | null;
  projectIdleDays?: number | null;
  isStale?: boolean;
}

export interface Synergy {
  id: string;
  projectA: { id: string; title: string };
  projectB: { id: string; title: string };
  similarityScore: number;
  rationale: string;
  closestNotes?: { noteATitle: string; noteAPath: string; noteBSTitle: string; noteBPath: string }[];
  hasExistingBridge?: boolean;
}

export interface SynergyBridge {
  bridgeTitle: string;
  overview: string;
  sharedProblems: string[];
  mutualBenefits: string[];
  markdownContent: string;
  isCached?: boolean;
  writtenToVault?: boolean;
  filePath?: string | null;
}

export interface Synthesis {
  title: string;
  executiveSummary: string;
  markdownContent?: string;
  suggestedNextSteps: string[];
  acceptedCount: number;
}

export interface ConsultAnswer {
  query: string;
  diagnosis: string;
  projectViability?: string | null;
  totalLibraryEvaluated: number;
  totalNotesEvaluated: number;
  matchedContents: { refId: string; id: string; uri: string; title: string | null; channelOrDomain?: string | null; whyItConnects: string }[];
  matchedNotes: { refId: string; projectTitle: string; noteTitle: string; notePath: string; contentSnippet: string | null; whyItConnects: string }[];
}

export interface VaultSettings {
  vaultPath: string | null;
  isConfigured: boolean;
  isValid: boolean;
  hasProjectsDir: boolean;
  projectsDirName: string | null;
  watcherActive: boolean;
  projects: { id: string; title: string; folderPath: string; isActive: boolean; existsOnDisk: boolean; suggestionsCount: number }[];
}

export interface LanguageSettings { preset: Language; outputLanguage: Language; notesLanguage: Language }
export interface SystemStatus { isProcessing: boolean; evaluatingJobs: number; ingestingJobs: number }

export const api = {
  status: () => get<SystemStatus>('/api/system/status'),
  ingest: (url: string) => request<{ contentId: string; status: string }>('POST', '/api/ingest', { url }),
  contents: (status?: IngestStatus) => get<{ items: ContentItem[]; total: number }>(`/api/contents?limit=50${status ? `&status=${status}` : ''}`),
  content: (id: string) => get<ContentDetail>(`/api/contents/${id}`),
  consult: (query: string) => send<ConsultAnswer>('POST', '/api/library/consult', { query }),
  projects: () => get<{ projects: Project[] }>('/api/projects'),
  suggestions: (status: SuggestionStatus, projectId?: string | null) =>
    get<{ items: Suggestion[]; total: number }>(`/api/suggestions?status=${status}&limit=50${projectId ? `&projectId=${projectId}` : ''}`),
  suggestion: (id: string) => get<{ confidenceScore: number | null; triageVerdict?: Verdict | null; triageReasoning: string | null }>(`/api/suggestions/${id}`),
  resolve: (id: string, status: 'accepted' | 'discarded', userFeedback?: string, discardReason?: DiscardReason) =>
    send<Suggestion>('PATCH', `/api/suggestions/${id}`, { status, userFeedback: userFeedback || undefined, discardReason }),
  reevaluate: (id: string) => send<{ resolution: 'keep_or_refine' | 'already_addressed' | 'obsolete' }>('POST', `/api/suggestions/${id}/reevaluate`),
  reevaluateStale: (projectId: string) => send<{ reevaluatedCount: number }>('POST', `/api/projects/${projectId}/reevaluate-stale`),
  synthesize: (projectId: string) => send<Synthesis>('POST', `/api/projects/${projectId}/synthesize`),
  saveSynthesis: (projectId: string, s: Synthesis) => send<{ filePath: string }>('POST', `/api/projects/${projectId}/synthesis/save`, s),
  synergies: () => get<{ synergies: Synergy[] }>('/api/projects/synergies'),
  exploreSynergy: (projectAId: string, projectBId: string, forceRegenerate: boolean) =>
    send<SynergyBridge>('POST', '/api/projects/synergies/explore', { projectAId, projectBId, forceRegenerate }),
  saveSynergy: (projectAId: string, projectBId: string, b: SynergyBridge) =>
    send<{ filePath: string }>('POST', '/api/projects/synergies/save', {
      projectAId, projectBId, bridgeTitle: b.bridgeTitle, overview: b.overview,
      sharedProblems: b.sharedProblems ?? [], mutualBenefits: b.mutualBenefits ?? [], markdownContent: b.markdownContent ?? '',
    }),
  vault: () => get<VaultSettings>('/api/settings/vault'),
  saveVault: (vaultPath: string) => send<{ summary?: { activeProjects: number; missingProjects: number } }>('POST', '/api/settings/vault', { vaultPath }),
  rescan: () => send<unknown>('POST', '/api/settings/vault/rescan'),
  languages: () => get<LanguageSettings>('/api/settings/language'),
  saveLanguages: (body: Partial<Pick<LanguageSettings, 'outputLanguage' | 'notesLanguage'>>) => send<LanguageSettings>('PUT', '/api/settings/language', body),
};
