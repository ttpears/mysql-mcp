import fs from 'fs';
import path from 'path';

export interface CachePruneResult {
  scannedFiles: number;
  removedFiles: number;
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.promises.chmod(directory, 0o700);
}

export async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await fs.promises.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fs.promises.chmod(filePath, 0o600);
}

export async function pruneExpiredCacheFiles(
  baseDirectory: string,
  retentionDays: number,
  nowMs = Date.now()
): Promise<CachePruneResult> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error('Cache retention days must be a positive number');
  }

  const result: CachePruneResult = { scannedFiles: 0, removedFiles: 0 };
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;

  async function visit(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      result.scannedFiles += 1;
      const stats = await fs.promises.stat(entryPath);
      if (stats.mtimeMs < cutoffMs) {
        await fs.promises.unlink(entryPath);
        result.removedFiles += 1;
      }
    }
  }

  await visit(baseDirectory);
  return result;
}
