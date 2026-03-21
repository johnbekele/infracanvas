// ZIP Export utilities for InfraCanvas

import JSZip from 'jszip';
import type { TerraformProject } from './terraform';
import type { PulumiProject } from './pulumi';
import type { PulumiLanguage } from '../types';

export async function exportTerraformZip(
  project: TerraformProject,
  designName: string
): Promise<{ blob: Blob; filename: string }> {
  const zip = new JSZip();

  project.files.forEach((file) => {
    zip.file(file.path, file.content);
  });

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${sanitizeFilename(designName)}-terraform.zip`;

  return { blob, filename };
}

export async function exportPulumiZip(
  project: PulumiProject,
  designName: string,
  language: PulumiLanguage
): Promise<{ blob: Blob; filename: string }> {
  const zip = new JSZip();

  project.files.forEach((file) => {
    zip.file(file.path, file.content);
  });

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${sanitizeFilename(designName)}-pulumi-${language}.zip`;

  return { blob, filename };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
