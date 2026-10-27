/**
 * The single in-memory scene document every editor writes into.
 *
 *   store.doc                  current (possibly unsaved) scene
 *   store.update(fn, what)     mutate a draft copy; listeners get the change
 *   store.dirty                differs from the last saved/loaded file
 *   store.markSaved(doc)       after a successful save (server copy)
 *   store.adoptServerBuild(d)  after a build: take build/buildAttempt from the
 *                              server without touching unsaved edits
 *
 * `build`, `buildAttempt` and `updatedAt` are owned by the server/pipeline and
 * never count as unsaved changes. Pure (no DOM), unit tested in store.test.ts.
 */
import type { SceneDoc } from "../../../shared/scene-schema.mjs";

export type SceneChange = "transform" | "parts" | "navigation" | "camera" | "floor" | "regions" | "build" | "saved" | "other";
export type SceneListener = (doc: SceneDoc, change: SceneChange) => void;

const SERVER_OWNED = new Set(["build", "buildAttempt", "updatedAt"]);

/** Canonical text of the user-editable part of a scene (key order independent). */
export function editableFingerprint(doc: SceneDoc): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  const editable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!SERVER_OWNED.has(k) && v !== undefined) editable[k] = v;
  return JSON.stringify(sortKeys(editable));
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class SceneStore {
  private current: SceneDoc;
  private saved: string;
  private readonly listeners = new Set<SceneListener>();

  constructor(doc: SceneDoc) {
    this.current = clone(doc);
    this.saved = editableFingerprint(this.current);
  }

  get doc(): Readonly<SceneDoc> {
    return this.current;
  }

  get name(): string {
    return this.current.name;
  }

  get dirty(): boolean {
    return editableFingerprint(this.current) !== this.saved;
  }

  /** Mutate a copy of the document; listeners are told what changed. */
  update(fn: (draft: SceneDoc) => void, change: SceneChange = "other"): void {
    const draft = clone(this.current);
    fn(draft);
    this.current = draft;
    this.emit(change);
  }

  /** The server saved `doc` (its response): it becomes the new baseline. */
  markSaved(doc: SceneDoc): void {
    const keepLocal = editableFingerprint(this.current) !== editableFingerprint(doc);
    if (keepLocal) {
      // Edits made while the save was in flight stay (and stay dirty).
      this.saved = editableFingerprint(doc);
      this.current = { ...clone(this.current), build: doc.build, buildAttempt: doc.buildAttempt, updatedAt: doc.updatedAt };
    } else {
      this.current = clone(doc);
      this.saved = editableFingerprint(this.current);
    }
    this.emit("saved");
  }

  /** A build finished (or the file changed on disk): take the server-owned fields only. */
  adoptServerBuild(doc: SceneDoc): void {
    this.current = { ...clone(this.current), build: clone(doc.build), buildAttempt: clone(doc.buildAttempt) };
    this.emit("build");
  }

  on(fn: SceneListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(change: SceneChange): void {
    for (const fn of this.listeners) fn(this.current, change);
  }
}
