import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

export interface TrackMetadata {
  lastActiveAt: string;
  preview: string;
  messageCount?: number;
}

export interface TracksFile {
  [trackId: string]: TrackMetadata;
}

export function getTracksFilePath(projectPath: string): string {
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".finger", "projects", hash, "tracks.json");
}

export async function readTracksMetadata(projectPath: string): Promise<TracksFile> {
  const filePath = getTracksFilePath(projectPath);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function writeTracksMetadata(projectPath: string, tracks: TracksFile): Promise<void> {
  const filePath = getTracksFilePath(projectPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(tracks, null, 2), "utf-8");
}

export function readTracksMetadataSync(projectPath: string): TracksFile {
  const filePath = getTracksFilePath(projectPath);
  try {
    const content = require("fs").readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function writeTracksMetadataSync(projectPath: string, tracks: TracksFile): void {
  const filePath = getTracksFilePath(projectPath);
  const fs = require("fs");
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(tracks, null, 2), "utf-8");
}


export async function updateTrackMetadata(
  projectPath: string,
  trackId: string,
  updates: Partial<TrackMetadata>
): Promise<void> {
  const tracks = await readTracksMetadata(projectPath);
  tracks[trackId] = {
    ...tracks[trackId],
    ...updates,
    lastActiveAt: updates.lastActiveAt || new Date().toISOString(),
  };
  await writeTracksMetadata(projectPath, tracks);
}

export async function getAvailableTracks(projectPath: string): Promise<Array<{ id: string; metadata: TrackMetadata }>> {
  const tracks = await readTracksMetadata(projectPath);
  return Object.entries(tracks)
    .map(([id, metadata]) => ({ id, metadata }))
    .sort((a, b) => new Date(b.metadata.lastActiveAt).getTime() - new Date(a.metadata.lastActiveAt).getTime());
}

export async function allocateTrack(projectPath: string, activeTracks: Set<string> = new Set()): Promise<string> {
  const existingTracks = await readTracksMetadata(projectPath);
  const existingIds = Object.keys(existingTracks);
  for (let i = 0; i <= existingIds.length; i++) {
    const candidate = `track${i}`;
    if (!activeTracks.has(candidate)) {
      return candidate;
    }
  }
  return `track${existingIds.length}`;
}

export function allocateTrackSync(projectPath: string, activeTracks: Set<string> = new Set()): string {
  const existingTracks = readTracksMetadataSync(projectPath);
  const existingIds = Object.keys(existingTracks);
  for (let i = 0; i <= existingIds.length; i++) {
    const candidate = `track${i}`;
    if (!activeTracks.has(candidate)) {
      return candidate;
    }
  }
  return `track${existingIds.length}`;
}

export function generatePreview(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > 100 ? trimmed.slice(0, 97) + "..." : trimmed;
}
