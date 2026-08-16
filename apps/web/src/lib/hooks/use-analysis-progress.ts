/**
 * Watching a queued analysis run.
 *
 * The spinner this replaces could not distinguish work in progress from a request
 * that had died, which is exactly the distinction the user wants: a repository
 * that takes a minute looked identical to one that was never going to finish.
 * The stream reports what the worker is doing, so a slow run reads as slow.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { repositoriesApi, type AnalysisStatus } from '../api/repositories';
import {
  applyFrame,
  applyOutcome,
  parseFrame,
  QUEUED,
  type AnalysisProgress,
  type ProgressFrame,
} from '../analysis/progress';

export type { AnalysisProgress } from '../analysis/progress';

/**
 * Subscribe to a run's progress until it finishes.
 *
 * Passing `null` closes the stream, which is how a caller stops watching a run
 * that has already finished rather than holding a connection open on a page the
 * user is still sitting on.
 */
export function useAnalysisProgress(
  repositoryId: string | undefined,
  analysisId: string | null
): AnalysisProgress | null {
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const queryClient = useQueryClient();
  // Held in a ref rather than depended on, so a re-render of the page does not
  // tear down and re-open the stream.
  const client = useRef(queryClient);
  client.current = queryClient;

  useEffect(() => {
    if (!repositoryId || !analysisId) {
      setProgress(null);
      return;
    }

    setProgress(QUEUED);

    // The run's outcome lives on the analyses list, which this stream does not
    // update. Refetching is what puts the finished profile on the page without
    // the user reloading.
    const refetchAnalyses = () =>
      void client.current.invalidateQueries({
        queryKey: ['repositories', repositoryId, 'analyses'],
      });

    // `withCredentials` so the session cookie travels: the API is a different
    // origin in a deployed build.
    const source = new EventSource(repositoriesApi.progressUrl(repositoryId, analysisId), {
      withCredentials: true,
    });

    source.addEventListener('progress', (event) => {
      const frame = parseFrame<ProgressFrame>(event.data);
      if (frame) setProgress((current) => applyFrame(current, frame));
    });

    const settle = (status: AnalysisStatus) => (event: MessageEvent) => {
      const frame = parseFrame<{ error: string | null }>(event.data);
      setProgress((current) => applyOutcome(current, status, frame?.error));
      refetchAnalyses();

      // Closed explicitly: an EventSource whose server ended the response
      // reconnects by design, and there is nothing left to watch.
      source.close();
    };

    source.addEventListener('succeeded', settle('succeeded'));
    source.addEventListener('failed', settle('failed'));

    source.addEventListener('error', () => {
      // Fires both for a dropped connection, which EventSource retries on its
      // own, and for a stream that will not reopen. Only the second is worth
      // acting on, and the analyses list is the authority on the outcome.
      if (source.readyState === EventSource.CLOSED) refetchAnalyses();
    });

    return () => source.close();
  }, [repositoryId, analysisId]);

  return progress;
}
