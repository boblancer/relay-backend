import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalScreenshot } from "@relay/automation-worker-browserbase";
import sharp from "sharp";

const artifactAccessTtlMs = 60 * 60 * 1_000;
const maximumThumbnailBytes = 100 * 1_024;

export interface ThumbnailReference {
  url: string;
  mediaType: "image/webp";
  width: number;
  height: number;
  expiresAt: string;
}

export interface ArtifactStoreOptions {
  directory: string;
  now?: () => number;
  randomUUID(): string;
}

interface StoredArtifact {
  expiresAt: number;
  path: string;
}

interface ThumbnailImage {
  bytes: Buffer;
  width: number;
  height: number;
}

async function encodeThumbnail(
  screenshot: TerminalScreenshot,
  width: number,
  quality: number,
): Promise<ThumbnailImage> {
  const { data, info } = await sharp(screenshot.bytes)
    .resize({ width, height: 300, fit: "inside", withoutEnlargement: true })
    .webp({ effort: 4, quality })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

async function createThumbnail(screenshot: TerminalScreenshot): Promise<ThumbnailImage | undefined> {
  const primary = await encodeThumbnail(screenshot, 480, 45);
  if (primary.bytes.byteLength <= maximumThumbnailBytes) return primary;
  const fallback = await encodeThumbnail(screenshot, 384, 30);
  return fallback.bytes.byteLength <= maximumThumbnailBytes ? fallback : undefined;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly now: () => number;

  constructor(private readonly options: ArtifactStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  async save(screenshot: TerminalScreenshot): Promise<ThumbnailReference | undefined> {
    let thumbnail: ThumbnailImage | undefined;
    try {
      thumbnail = await createThumbnail(screenshot);
    } catch {
      return undefined;
    }
    if (!thumbnail) return undefined;

    const artifactId = this.options.randomUUID();
    const path = join(this.options.directory, `${artifactId}.webp`);
    const temporaryPath = join(this.options.directory, `.${artifactId}.tmp`);
    try {
      await mkdir(this.options.directory, { mode: 0o700, recursive: true });
      await writeFile(temporaryPath, thumbnail.bytes, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, path);
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
      return undefined;
    }

    const expiresAt = this.now() + artifactAccessTtlMs;
    this.artifacts.set(artifactId, { expiresAt, path });
    return {
      url: `/v1/artifacts/${artifactId}`,
      mediaType: "image/webp",
      width: thumbnail.width,
      height: thumbnail.height,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async read(artifactId: string): Promise<{ bytes: Buffer; mediaType: "image/webp" } | undefined> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return undefined;
    if (artifact.expiresAt <= this.now()) {
      this.artifacts.delete(artifactId);
      return undefined;
    }
    try {
      return { bytes: await readFile(artifact.path), mediaType: "image/webp" };
    } catch {
      this.artifacts.delete(artifactId);
      return undefined;
    }
  }
}
