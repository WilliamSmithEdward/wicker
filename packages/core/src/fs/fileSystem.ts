/**
 * The only filesystem surface the engine is allowed to touch.
 *
 * Keeping this narrow buys three things: the engine can be driven entirely
 * in-memory from tests, it can later sit on VS Code's `workspace.fs` so that
 * remote and virtual workspaces work unchanged, and every read is funnelled
 * through one place that can cache or instrument it.
 *
 * Absence is not an error. A missing file is the ordinary case when resolving
 * a template candidate list, so reads answer with undefined rather than
 * throwing, and only genuinely unexpected conditions propagate.
 */

export type FileType = 'file' | 'directory';

export interface DirectoryEntry {
  readonly name: string;
  readonly type: FileType;
}

export interface FileStat {
  readonly type: FileType;
}

export interface WickerFileSystem {
  /** File contents as UTF-8, or undefined when it does not exist or is a directory. */
  readFile(absolutePath: string): Promise<string | undefined>;

  /** Entry metadata, or undefined when nothing exists at the path. */
  stat(absolutePath: string): Promise<FileStat | undefined>;

  /** Immediate children, or an empty list when the path is missing or a file. */
  readDirectory(absolutePath: string): Promise<readonly DirectoryEntry[]>;
}

/** Convenience predicate; avoids repeating the stat-and-compare dance. */
export async function fileExists(
  fileSystem: WickerFileSystem,
  absolutePath: string,
): Promise<boolean> {
  const stat = await fileSystem.stat(absolutePath);
  return stat?.type === 'file';
}

/** Convenience predicate for directories. */
export async function directoryExists(
  fileSystem: WickerFileSystem,
  absolutePath: string,
): Promise<boolean> {
  const stat = await fileSystem.stat(absolutePath);
  return stat?.type === 'directory';
}
