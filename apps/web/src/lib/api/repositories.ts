// Connected repositories and their analyses.
import type { AppProfile } from '@infracanvas/core';
import { apiFetch, apiUrl } from './client';

export interface ConnectedRepository {
  id: string;
  userId: string;
  githubId: number;
  githubOwner: string;
  githubName: string;
  defaultBranch: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AnalysisStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Analysis {
  id: string;
  repositoryId: string;
  ref: string;
  commitSha: string | null;
  status: AnalysisStatus;
  profile: AppProfile | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const repositoriesApi = {
  async list() {
    const { repositories } = await apiFetch<{ repositories: ConnectedRepository[] }>(
      '/repositories'
    );
    return repositories;
  },

  async get(id: string) {
    const { repository } = await apiFetch<{ repository: ConnectedRepository }>(
      `/repositories/${id}`
    );
    return repository;
  },

  /**
   * Connect a repository by owner and name. The server reads the rest of the
   * details from GitHub, so nothing here can claim access it does not have.
   */
  async connect(owner: string, repo: string) {
    const { repository } = await apiFetch<{ repository: ConnectedRepository }>('/repositories', {
      method: 'POST',
      body: JSON.stringify({ owner, repo }),
    });
    return repository;
  },

  async disconnect(id: string) {
    await apiFetch<void>(`/repositories/${id}`, { method: 'DELETE' });
  },

  async listAnalyses(repositoryId: string) {
    const { analyses } = await apiFetch<{ analyses: Analysis[] }>(
      `/repositories/${repositoryId}/analyses`
    );
    return analyses;
  },

  /**
   * Ask for an analysis. Returns the queued run, which has no profile yet.
   *
   * The result arrives on the progress stream rather than from this call, so a
   * repository large enough to take a minute is no longer a request racing a
   * proxy timeout.
   */
  async analyse(repositoryId: string, ref?: string) {
    const { analysis } = await apiFetch<{ analysis: Analysis; jobId?: string }>(
      `/repositories/${repositoryId}/analyses`,
      { method: 'POST', body: JSON.stringify(ref ? { ref } : {}) }
    );
    return analysis;
  },

  /** Where to point an `EventSource` for a run's progress. */
  progressUrl(repositoryId: string, analysisId: string) {
    return apiUrl(`/repositories/${repositoryId}/analyses/${analysisId}/events`);
  },
};
