import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { DesignerPage } from '@/pages/DesignerPage';
import { LandingPage } from '@/pages/LandingPage';
import { CallbackPage } from '@/pages/CallbackPage';
import { RepositoriesPage } from '@/pages/RepositoriesPage';
import { RepositoryPage } from '@/pages/RepositoryPage';

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/repositories" element={<RepositoriesPage />} />
        <Route path="/repositories/:id" element={<RepositoryPage />} />
        <Route path="/designer" element={<DesignerPage />} />
        <Route path="/callback" element={<CallbackPage />} />
      </Routes>
      <Toaster />
    </>
  );
}

export default App;
