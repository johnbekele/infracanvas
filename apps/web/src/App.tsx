import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { LandingPage } from '@/pages/LandingPage';
import { CallbackPage } from '@/pages/CallbackPage';
import { RepositoriesPage } from '@/pages/RepositoriesPage';
import { RepositoryPage } from '@/pages/RepositoryPage';

/**
 * The designer is loaded on demand. React Flow and the code generators are the
 * bulk of the bundle, and nobody landing on the repository list needs either of
 * them until they open a design.
 */
const DesignerPage = lazy(() =>
  import('@/pages/DesignerPage').then((module) => ({ default: module.DesignerPage }))
);

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/repositories" element={<RepositoriesPage />} />
        <Route path="/repositories/:id" element={<RepositoryPage />} />
        <Route
          path="/designer"
          element={
            <Suspense
              fallback={
                <div className="flex h-screen items-center justify-center text-sm text-gray-500">
                  Loading the designer…
                </div>
              }
            >
              <DesignerPage />
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
