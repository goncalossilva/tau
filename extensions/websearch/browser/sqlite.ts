import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function withSqliteSnapshot<T>(
  sourceDbPath: string,
  tempPrefix: string,
  operation: (snapshotPath: string) => T,
): T {
  const tempDir = path.join(os.tmpdir(), `${tempPrefix}-${process.pid}-${Date.now()}`);
  const snapshotPath = path.join(tempDir, path.basename(sourceDbPath));

  try {
    mkdirSync(tempDir, { recursive: true });
    copyFileSync(sourceDbPath, snapshotPath);
    copySidecar(sourceDbPath, snapshotPath, "-wal");
    copySidecar(sourceDbPath, snapshotPath, "-shm");
    copySidecar(sourceDbPath, snapshotPath, "-journal");
    return operation(snapshotPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function copySidecar(sourceDbPath: string, targetDbPath: string, suffix: string): void {
  const source = `${sourceDbPath}${suffix}`;
  if (!existsSync(source)) return;

  try {
    copyFileSync(source, `${targetDbPath}${suffix}`);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code !== "ENOENT") throw error;
  }
}
