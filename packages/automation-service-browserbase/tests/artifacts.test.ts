import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";

const directories: string[] = [];

async function artifactDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "relay-artifacts-test-"));
  directories.push(directory);
  return directory;
}

async function screenshotPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1_440,
      height: 900,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  })
    .png()
    .toBuffer();
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("ArtifactStore", () => {
  it("persists a bounded WebP and exposes it through an expiring in-memory reference", async () => {
    const directory = await artifactDirectory();
    let now = Date.parse("2026-08-05T22:00:00.000Z");
    const store = new ArtifactStore({
      directory,
      now: () => now,
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    });

    const thumbnail = await store.save({ bytes: await screenshotPng(), mediaType: "image/png" });

    expect(thumbnail).toEqual({
      url: "/v1/artifacts/11111111-1111-4111-8111-111111111111",
      mediaType: "image/webp",
      width: 480,
      height: 300,
      expiresAt: "2026-08-05T23:00:00.000Z",
    });
    const image = await store.read("11111111-1111-4111-8111-111111111111");
    expect(image?.mediaType).toBe("image/webp");
    expect(image?.bytes.byteLength).toBeLessThanOrEqual(100 * 1_024);
    expect(await sharp(image!.bytes).metadata()).toMatchObject({
      format: "webp",
      width: 480,
      height: 300,
    });

    now += 60 * 60 * 1_000 + 1;
    expect(await store.read("11111111-1111-4111-8111-111111111111")).toBeUndefined();
    expect(
      await readFile(join(directory, "11111111-1111-4111-8111-111111111111.webp")),
    ).toEqual(image!.bytes);
  });

  it("does not allow a new process store to serve files already present on disk", async () => {
    const directory = await artifactDirectory();
    const artifactId = "22222222-2222-4222-8222-222222222222";
    const first = new ArtifactStore({ directory, randomUUID: () => artifactId });
    await first.save({ bytes: await screenshotPng(), mediaType: "image/png" });

    const restarted = new ArtifactStore({ directory, randomUUID: () => artifactId });

    expect(await restarted.read(artifactId)).toBeUndefined();
    expect(await readFile(join(directory, `${artifactId}.webp`))).toBeInstanceOf(Buffer);
  });

  it("omits an artifact when image conversion fails", async () => {
    const directory = await artifactDirectory();
    const store = new ArtifactStore({
      directory,
      randomUUID: () => "33333333-3333-4333-8333-333333333333",
    });

    await expect(
      store.save({ bytes: Buffer.from("not an image"), mediaType: "image/png" }),
    ).resolves.toBeUndefined();
    expect(await store.read("33333333-3333-4333-8333-333333333333")).toBeUndefined();
  });

  it("omits an artifact when the configured directory cannot be written", async () => {
    const directory = await artifactDirectory();
    const blockingFile = join(directory, "not-a-directory");
    await writeFile(blockingFile, "blocked");
    const store = new ArtifactStore({
      directory: blockingFile,
      randomUUID: () => "44444444-4444-4444-8444-444444444444",
    });

    await expect(
      store.save({ bytes: await screenshotPng(), mediaType: "image/png" }),
    ).resolves.toBeUndefined();
  });
});
