import { Routes, Route } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { DesignerPage } from '@/pages/DesignerPage';
import { LandingPage } from '@/pages/LandingPage';
import { CallbackPage } from '@/pages/CallbackPage';

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/designer" element={<DesignerPage />} />
        <Route path="/callback" element={<CallbackPage />} />
      </Routes>
      <Toaster />
    </>
  );
}

export default App;
