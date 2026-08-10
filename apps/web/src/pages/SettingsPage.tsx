import { useEffect } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { AuthMethodPicker } from '@/components/auth';
import { CredentialForm } from '@/components/settings/CredentialForm';
import { CredentialList } from '@/components/settings/CredentialList';
import { PreferencesForm } from '@/components/settings/PreferencesForm';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useSettings } from '@/lib/hooks/use-settings';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
      <p className="mb-4 mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const { isAuthenticated, isLoading: isAuthLoading, checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const { data, isLoading } = useSettings();

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <AppHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Settings</h1>
        <p className="mb-6 mt-1 text-sm text-gray-500 dark:text-gray-400">
          Your model access and the defaults used when estimating an architecture.
        </p>

        {isAuthLoading || isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : !isAuthenticated ? (
          <AuthMethodPicker />
        ) : (
          <div className="space-y-6">
            <Section
              title="Models"
              description="Your own keys, encrypted at rest and used only by this server on your behalf. Architecture proposals come from deterministic rules either way; a model adds the explanation and the critique."
            >
              <CredentialList credentials={data?.credentials ?? []} />
              <div className="mt-6 border-t border-gray-100 pt-6 dark:border-gray-800">
                <CredentialForm />
              </div>
            </Section>

            {data && (
              <Section title="Defaults" description="Applied to new analyses and cost estimates.">
                <PreferencesForm settings={data.settings} />
              </Section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
