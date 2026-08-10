import { AlertCircle, Box, FileCode, Layers, Package } from 'lucide-react';
import type { AppProfile } from '@infracanvas/core';

interface ProfileSummaryProps {
  profile: AppProfile;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CATEGORY_LABELS: Record<string, string> = {
  'web-framework': 'Web',
  'frontend-framework': 'Frontend',
  datastore: 'Database',
  cache: 'Cache',
  queue: 'Queue',
  search: 'Search',
  orm: 'ORM',
  'cloud-sdk': 'Cloud SDK',
  ml: 'Machine learning',
  other: 'Other',
};

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ProfileSummary({ profile }: ProfileSummaryProps) {
  const topLanguages = profile.languages.slice(0, 6);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Section icon={<FileCode className="h-4 w-4 text-violet-500" />} title="Languages">
        {topLanguages.length === 0 ? (
          <p className="text-sm text-gray-500">GitHub classified no code in this repository.</p>
        ) : (
          <ul className="space-y-2">
            {topLanguages.map((language) => (
              <li key={language.name}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-gray-700 dark:text-gray-300">{language.name}</span>
                  <span className="text-gray-500">{Math.round(language.share * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div
                    className="h-full rounded-full bg-violet-500"
                    style={{ width: `${Math.max(language.share * 100, 1)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-gray-500">
          {profile.fileCount.toLocaleString()} files, {formatBytes(profile.totalBytes)}
        </p>
      </Section>

      <Section icon={<Layers className="h-4 w-4 text-violet-500" />} title="Components">
        {profile.components.length === 0 ? (
          <p className="text-sm text-gray-500">No dependency manifests were found.</p>
        ) : (
          <ul className="space-y-2">
            {profile.components.map((component) => (
              <li key={component.manifestPath} className="text-sm">
                <span className="font-medium text-gray-900 dark:text-white">{component.name}</span>
                <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  {component.ecosystem}
                </span>
                <p className="text-xs text-gray-500">
                  {component.manifestPath} · {component.dependencyCount} dependencies
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        icon={<Package className="h-4 w-4 text-violet-500" />}
        title="Infrastructure-relevant dependencies"
      >
        {profile.dependencies.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing that implies a database, cache, or queue was found.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {profile.dependencies.map((dependency) => (
              <li key={`${dependency.ecosystem}:${dependency.name}`} className="text-sm">
                <span className="font-mono text-xs text-gray-900 dark:text-white">
                  {dependency.name}
                </span>
                <span className="ml-2 text-xs text-gray-500">
                  {CATEGORY_LABELS[dependency.category] ?? dependency.category}
                </span>
                {/* The path is shown so any finding can be checked against the source. */}
                <p className="font-mono text-[11px] text-gray-400">{dependency.sourcePath}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<Box className="h-4 w-4 text-violet-500" />} title="Packaging">
        {profile.containerisation.dockerfiles.length === 0 ? (
          <p className="text-sm text-gray-500">
            No Dockerfile was found, so there is no container image to run as-is.
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-gray-700 dark:text-gray-300">
              {profile.containerisation.dockerfiles.length} Dockerfile
              {profile.containerisation.dockerfiles.length === 1 ? '' : 's'}
            </p>
            <ul className="font-mono text-xs text-gray-500">
              {profile.containerisation.dockerfiles.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
            {profile.containerisation.exposedPorts.length > 0 && (
              <p className="text-xs text-gray-500">
                Ports: {profile.containerisation.exposedPorts.join(', ')}
              </p>
            )}
          </div>
        )}
      </Section>

      {profile.notes.length > 0 && (
        <div className="md:col-span-2">
          <Section
            icon={<AlertCircle className="h-4 w-4 text-amber-500" />}
            title="Limits of this analysis"
          >
            <ul className="list-inside list-disc space-y-1 text-sm text-gray-600 dark:text-gray-400">
              {profile.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </div>
  );
}
