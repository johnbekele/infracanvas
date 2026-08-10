import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { LandingPage } from '@/pages/LandingPage';
import { CallbackPage } from '@/pages/CallbackPage';
import { RepositoriesPage } from '@/pages/RepositoriesPage';

/**
 * The designer is loaded on demand. React Flow and the code generators are the
 * bulk of the bundle, and nobody landing on the repository list needs either of
 * them until they open a design.
 */
const DesignerPage = lazy(() =>
  import('@/pages/DesignerPage').then((module) => ({ default: module.DesignerPage }))
);

/**
 * A repository page draws an architecture, so it pulls in the service catalog
 * and the synthesis engine. Both grew by an order of magnitude with this change
 * and neither is needed to render the list of repositories.
 */
const RepositoryPage = lazy(() =>
  import('@/pages/RepositoryPage').then((module) => ({ default: module.RepositoryPage }))
);

/** Visited rarely, and mostly once. It should not be in the first payload either. */
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage }))
);

function Loading({ what }: { what: string }) {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-gray-500">
      Loading {what}…
    </div>
  );
}

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/repositories" element={<RepositoriesPage />} />
        <Route
          path="/repositories/:id"
          element={
            <Suspense fallback={<Loading what="the repository" />}>
              <RepositoryPage />
            </Suspense>
          }
        />
        <Route
          path="/designer"
          element={
            <Suspense fallback={<Loading what="the designer" />}>
              <DesignerPage />
            </Suspense>
          }
        />
        <Route
          path="/settings"
          element={
            <Suspense fallback={<Loading what="settings" />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route path="/callback" element={<CallbackPage />} />
      </Routes>
      <Toaster />
    </>
  );
}

export default App;
