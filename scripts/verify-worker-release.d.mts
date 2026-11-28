export interface SealedFileMeta {
  sha256: string;
  bytes: number;
  immutable: boolean;
}

export interface CoreFileMeta {
  path: string;
  sha256: string;
  bytes: number;
}

export interface WorkerReleaseSeal {
  version: 1;
  release: string;
  profile: string;
  sealedAt: string;
  worker: CoreFileMeta;
  headers: CoreFileMeta;
  assetsIgnore: CoreFileMeta;
  bootReferences: string[];
  files: Record<string, SealedFileMeta>;
}

export interface SealWorkerReleaseOptions {
  workerDir: string;
  sealPath: string;
  release: string;
  profile?: string;
  htmlShells?: string[];
}

export interface VerifyWorkerReleaseOptions {
  workerDir: string;
  sealPath: string;
  expectedRelease?: string;
  previousSealPath?: string;
}

export interface VerifyWorkerReleaseSummary {
  release: string;
  sealedFiles: number;
  bootReferences: number;
  carriedPreviousAssets: number;
  sharedImmutableAssets: number;
}

export interface VerifyWorkerReleaseResult {
  ok: boolean;
  errors: string[];
  summary: VerifyWorkerReleaseSummary | null;
}

export function extractBootReferences(texts: Array<string | null | undefined>): string[];
export function looksLikeHtmlAsset(relPath: string, buf: Buffer): boolean;
export function sealWorkerRelease(options: SealWorkerReleaseOptions): WorkerReleaseSeal;
export function verifyWorkerRelease(options: VerifyWorkerReleaseOptions): VerifyWorkerReleaseResult;
