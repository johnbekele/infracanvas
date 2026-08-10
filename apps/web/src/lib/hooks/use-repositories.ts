// Data hooks for connected repositories and their analyses.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { repositoriesApi } from '../api/repositories';

const keys = {
  all: ['repositories'] as const,
  detail: (id: string) => ['repositories', id] as const,
  analyses: (id: string) => ['repositories', id, 'analyses'] as const,
};

export function useConnectedRepositories() {
  return useQuery({ queryKey: keys.all, queryFn: repositoriesApi.list });
}

export function useRepository(id: string | undefined) {
  return useQuery({
    queryKey: keys.detail(id ?? ''),
    queryFn: () => repositoriesApi.get(id!),
    enabled: Boolean(id),
  });
}

/** GitHub repositories available to connect, which is a different list from the connected one. */
export function useGitHubRepositories(enabled: boolean) {
  return useQuery({
    queryKey: ['github', 'repos'],
    queryFn: async () => (await import('../api/client')).githubApi.listRepos(),
    enabled,
    // GitHub's listing changes rarely and the request is not cheap, so it is
    // not refetched every time the picker opens.
    staleTime: 5 * 60 * 1000,
  });
}

export function useConnectRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ owner, repo }: { owner: string; repo: string }) =>
      repositoriesApi.connect(owner, repo),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useDisconnectRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => repositoriesApi.disconnect(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useAnalyses(repositoryId: string | undefined) {
  return useQuery({
    queryKey: keys.analyses(repositoryId ?? ''),
    queryFn: () => repositoriesApi.listAnalyses(repositoryId!),
    enabled: Boolean(repositoryId),
  });
}

export function useRunAnalysis(repositoryId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ref?: string) => repositoriesApi.analyse(repositoryId!, ref),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.analyses(repositoryId ?? '') }),
  });
}
