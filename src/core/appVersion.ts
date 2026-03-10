import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageVersion(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const searchRoots = [
    moduleDir,
    dirname(moduleDir),
    dirname(dirname(moduleDir)),
    dirname(dirname(dirname(moduleDir))),
  ];

  for (const root of searchRoots) {
    const packageJsonPath = join(root, 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {
      // Try next candidate.
    }
  }

  return '0.0.0';
}

export const APP_VERSION = findPackageVersion();
