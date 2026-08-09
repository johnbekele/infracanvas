import { Github, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/stores/auth-store';

interface LoginButtonProps {
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}

export function LoginButton({
  variant = 'default',
  size = 'default',
  className,
}: LoginButtonProps) {
  const { login, isLoading } = useAuthStore();

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={login}
      disabled={isLoading}
    >
      {isLoading ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <Github className="mr-2 h-4 w-4" />
      )}
      Connect GitHub
    </Button>
  );
}
