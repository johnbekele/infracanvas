// Data hooks for user settings and model credentials.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi, type NewCredential, type UserSettings } from '../api/settings';

const key = ['settings'] as const;

export function useSettings() {
  return useQuery({ queryKey: key, queryFn: settingsApi.get });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: Partial<UserSettings>) => settingsApi.update(patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useAddCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: NewCredential) => settingsApi.addCredential(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => settingsApi.deleteCredential(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useMakeDefaultCredential() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => settingsApi.makeDefault(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Verification is not cached: it answers "does this work right now", and a
 * remembered answer from ten minutes ago is exactly the wrong thing to show.
 */
export function useVerifyCredential() {
  return useMutation({ mutationFn: (id: string) => settingsApi.verify(id) });
}
