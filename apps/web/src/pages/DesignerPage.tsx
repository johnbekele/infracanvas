import { DesignerCanvas } from '@/components/designer/DesignerCanvas';
import { AppHeader } from '@/components/layout/AppHeader';

export function DesignerPage() {
  return (
    <div className="flex h-screen flex-col">
      <AppHeader />
      <DesignerCanvas />
    </div>
  );
}
