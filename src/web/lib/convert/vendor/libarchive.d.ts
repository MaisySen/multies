// Types for the vendored libarchive.js 2.0.2 reader (MIT, see THIRD_PARTY_NOTICES.md). Only what Multies uses.
export interface CompressedFile { name: string; size: number; extract(): Promise<File> }
export interface ArchiveReader {
  hasEncryptedData(): Promise<boolean | null>;
  getFilesArray(): Promise<{ file: CompressedFile; path: string }[]>;
  extractFiles(each?: (entry: { file: File; path: string }) => void): Promise<unknown>;
  close(): Promise<void>;
}
export declare const Archive: {
  init(opts: { getWorker?: () => Worker }): unknown;
  open(file: File): Promise<ArchiveReader>;
};
