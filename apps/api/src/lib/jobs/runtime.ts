/**
 * The worker this process runs, and how it is turned off.
 *
 * In-process rather than a separate deployment. The queue is a table, so nothing
 * about the design requires them to share a process, and splitting them later is
 * a deployment change rather than a rewrite -- but running two services to
 * analyse a repository is two things to deploy, monitor and keep in step, and
 * there is no traffic here that justifies it yet.
 *
 * `WORKER_ENABLED=false` is the seam. Scaling out means running one process with
 * the worker off behind the load balancer and one with it on, without changing
 * any code.
 */
import { env } from '../env.js';
import { Worker } from './worker.js';
import { analyzeRepositoryHandler } from './handlers/analyze-repository.js';

let worker: Worker | null = null;

export function startWorker(): Worker | null {
  if (!env().WORKER_ENABLED) return null;
  if (worker) return worker;

  worker = new Worker({ concurrency: env().WORKER_CONCURRENCY });

  worker.register(analyzeRepositoryHandler());
  worker.start();

  return worker;
}

/** Let running jobs go back to the queue before the process exits. */
export async function stopWorker(): Promise<void> {
  const running = worker;
  worker = null;
  if (running) await running.stop();
}
