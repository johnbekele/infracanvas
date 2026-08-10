import { useEffect } from 'react';
import { DesignerCanvas } from '@/components/designer/DesignerCanvas';
import { AppHeader } from '@/components/layout/AppHeader';
import { useAuthStore } from '@/lib/stores/auth-store';

export function DesignerPage() {
  const checkAuth = useAuthStore((state) => state.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <div className="flex h-screen flex-col">
      <AppHeader />
      <DesignerCanvas />
    </div>
  );
}
