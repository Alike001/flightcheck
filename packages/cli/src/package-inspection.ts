import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

export const CURRENT_0G_PACKAGES = {
  storage: "@0gfoundation/0g-storage-ts-sdk",
  compute: "@0gfoundation/0g-compute-ts-sdk",
} as const;

export const LEGACY_0G_PACKAGES = {
  "@0glabs/0g-ts-sdk": CURRENT_0G_PACKAGES.storage,
  "@0glabs/0g-serving-broker": CURRENT_0G_PACKAGES.compute,
} as const;

const DependencyMapSchema = z.record(z.string(), z.string().min(1));

const PackageJsonSchema = z.object({
  name: z.string().min(1).optional(),
  packageManager: z.string().min(1).optional(),
  dependencies: DependencyMapSchema.optional(),
  devDependencies: DependencyMapSchema.optional(),
  optionalDependencies: DependencyMapSchema.optional(),
  peerDependencies: DependencyMapSchema.optional(),
});

export type ProjectPackage = z.infer<typeof PackageJsonSchema>;

export async function readProjectPackage(projectDirectory: string): Promise<ProjectPackage> {
  const source = await readFile(join(projectDirectory, "package.json"), "utf8");
  return PackageJsonSchema.parse(JSON.parse(source) as unknown);
}

export function allDeclaredDependencies(projectPackage: ProjectPackage): ReadonlyMap<string, string> {
  return new Map(
    Object.entries({
      ...projectPackage.peerDependencies,
      ...projectPackage.optionalDependencies,
      ...projectPackage.devDependencies,
      ...projectPackage.dependencies,
    }),
  );
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"] as const;

export async function findLockfile(projectDirectory: string): Promise<string | undefined> {
  for (const filename of LOCKFILES) {
    try {
      await access(join(projectDirectory, filename));
      return filename;
    } catch {
      // Continue until a supported lockfile is found.
    }
  }

  return undefined;
}
