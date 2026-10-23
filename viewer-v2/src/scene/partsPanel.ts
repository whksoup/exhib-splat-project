/**
 * Parts panel (L): the scene's source parts with their build state, splat
 * counts and sizes; show / hide each part in the view (not saved), enable or
 * disable it (saved: disabled parts are neither built nor shown), add parts
 * from assets/source_ply, remove parts, preview an unbuilt part when the scene
 * is over the preview size cap, and rebuild a single part.
 *
 * Regions: drop a Spirula ROI region .json on the panel (or "Load regions…");
 * it is copied to assets/roi/<scene>/ and becomes the scene's `roi`. Each part
 * then ticks the areas (outlines saved in that file) it was trained on; the
 * build keeps only that part's splats inside the union of its areas. A part
 * with no area ticked is built whole.
 *
 * All parts share the scene transform (Align moves them together).
 */
import { outlinesOf, partIdFromSource, partBuild, sortOutlines, sourceFileName, type PartLoad, type ScenePart } from "../../../shared/scene-schema.mjs";
import { confirmDialog, dialog, el, fmtBytes, fmtCount, fmtTime, toast } from "../ui/dom";
import { api, type RoiFileInfo } from "./api";
import type { PartFileInfo } from "./sceneConfig";
import type { SceneStore } from "./store";

export interface PartsHost {
  /** Current load plan per part (what is shown and why). */
  parts(): PartLoad[];
  info(): PartFileInfo[] | null;
  capBytes(): number;
  isVisible(id: string): boolean;
  setVisible(id: string, on: boolean): void;
  isPreviewed(id: string): boolean;
  /** Opt in to loading an unbuilt part's source although the scene is over the cap. */
  setPreviewed(id: string, on: boolean): void;
  /** Re-read file sizes / build state from the dev server and reload what changed. */
  refresh(): Promise<void>;
  /** Rebuild only these parts (build-scene --part). */
  buildParts(ids: string[]): void;
}

const STATE_TEXT: Record<string, string> = {
  built: "built",
  outdated: "outdated",
  "not-built": "not built",
  disabled: "disabled",
};

const MODE_TEXT: Record<string, string> = {
  built: "streaming .rad",
  source: "source preview",
  blocked: "not loaded (over preview cap)",
  missing: "source missing",
  disabled: "",
};

type RegionState = RoiFileInfo | { error: string };

/** "Outline 12" -> "12" (chips stay short); other names as they are. */
const shortOutline = (name: string) => /^Outline (\d+)$/.exec(name)?.[1] ?? name;

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

let dropGuard = false;
/** A file dropped next to the panel must not make the browser navigate to it. */
function guardWindowDrops(): void {
  if (dropGuard) return;
  dropGuard = true;
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });
}

export class PartsPanel {
  readonly panel: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly note: HTMLDivElement;
  private readonly regionBar: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;
  /** Spherical-harmonics degree build-lod keeps (scene buildOptions.maxSh). */
  private readonly shSelect: HTMLSelectElement;
  /** Region files read from the dev server, by repo path. */
  private readonly regions = new Map<string, RegionState>();
  private readonly loadingRegions = new Set<string>();

  constructor(
    private readonly store: SceneStore,
    private readonly host: PartsHost,
  ) {
    this.list = el("div", { className: "parts-list" });
    this.note = el("div", { className: "panel-note" });
    this.regionBar = el("div", { className: "region-bar" });
    this.fileInput = el("input", { type: "file", accept: ".json,application/json", hidden: true });
    this.fileInput.addEventListener("change", () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (f) void this.loadRegionFile(f);
    });
    this.shSelect = el("select", {
      title:
        "Spherical-harmonics degree the build keeps (view-dependent colour: sheen, reflections). " +
        "1 is the scope default; 3 matches Spirula's training but triples the SH data on disk and doubles GPU memory per streamed splat. " +
        "Changing it rebuilds every part.",
    }, [0, 1, 2, 3].map((n) => el("option", { value: String(n), textContent: `SH ${n}${n === 1 ? " (default)" : n === 3 ? " (as trained)" : ""}` })));
    this.shSelect.addEventListener("change", () => {
      const n = Number(this.shSelect.value);
      this.store.update((d) => {
        if (n === 1) delete d.buildOptions.maxSh;
        else d.buildOptions.maxSh = n;
      }, "other");
      toast(`SH degree ${n}: save, then Build (every part is rebuilt).`, "info");
    });
    const title = el("strong", { textContent: "Parts" });
    this.panel = el("div", { className: "plan-panel parts-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [title, el("button", { textContent: "Close", title: "Hide (L)", onclick: () => this.show(false) })]),
      this.note,
      this.regionBar,
      this.fileInput,
      this.list,
      el("div", { className: "plan-row" }, [
        el("button", { textContent: "+ Add parts…", title: "Add source files from assets/source_ply (same coordinate frame as the other parts)", onclick: () => void this.addParts() }),
        el("button", { textContent: "↻", title: "Re-read file sizes and build state", onclick: () => void this.host.refresh() }),
        el("button", { textContent: "Show all", onclick: () => this.showAll() }),
        this.shSelect,
      ]),
    ]);
    title.addEventListener("click", () => this.panel.classList.toggle("collapsed"));

    guardWindowDrops();
    this.panel.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      this.panel.classList.add("drop-target");
    });
    this.panel.addEventListener("dragleave", (e) => {
      if (!this.panel.contains(e.relatedTarget as Node | null)) this.panel.classList.remove("drop-target");
    });
    this.panel.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.panel.classList.remove("drop-target");
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.name.toLowerCase().endsWith(".json"));
      if (!f) return void toast("Drop a Spirula ROI region .json file here.", "warn");
      void this.loadRegionFile(f);
    });
  }

  get visible(): boolean {
    return !this.panel.hidden;
  }

  show(on = true): void {
    this.panel.hidden = !on;
    if (on) {
      this.panel.classList.remove("collapsed");
      this.render();
    }
  }

  render(): void {
    if (this.panel.hidden) return;
    const doc = this.store.doc;
    const plan = new Map(this.host.parts().map((p) => [p.id, p]));
    const info = new Map((this.host.info() ?? []).map((p) => [p.id, p]));
    const total = doc.parts.reduce((s, p) => s + (info.get(p.id)?.bytes ?? 0), 0);
    const blocked = [...plan.values()].filter((p) => p.mode === "blocked");
    this.note.textContent =
      `${doc.parts.length} part${doc.parts.length === 1 ? "" : "s"}, ${fmtBytes(total)} of sources. One scene transform for all of them.` +
      (blocked.length ? ` Unbuilt sources over the ${fmtBytes(this.host.capBytes())} preview cap are not loaded: Build, or Preview one part.` : "");
    this.renderRegionBar();
    this.shSelect.value = String(doc.buildOptions?.maxSh ?? 1);
    // Which parts picked each area of each region file (shown on the chips: overlaps draw twice).
    const owners = new Map<string, string[]>();
    for (const p of doc.parts) {
      const file = p.roi || doc.roi;
      if (!file || p.enabled === false) continue;
      for (const o of outlinesOf(p)) owners.set(`${file}\n${o}`, [...(owners.get(`${file}\n${o}`) ?? []), p.id]);
    }
    this.list.replaceChildren(...doc.parts.map((p) => this.row(p, plan.get(p.id), info.get(p.id), owners)));
  }

  /** The scene's region file: what it is, and Load / Replace / remove. */
  private renderRegionBar(): void {
    const file = this.store.doc.roi ?? null;
    const load = el("button", {
      textContent: file ? "Replace…" : "Load regions…",
      title: "Pick a Spirula ROI region .json (or drop it on this panel). It is copied to assets/roi/<scene>/; dropping a newer save of the same file updates it.",
      onclick: () => this.fileInput.click(),
    });
    if (!file) {
      this.regionBar.replaceChildren(el("span", { textContent: "Regions: drop a Spirula ROI .json here to crop each part to the areas it was trained on." }), load);
      return;
    }
    const r = this.region(file);
    const usable = r && !("error" in r) ? r.outlines.filter((o) => o.usable).length : 0;
    const text = !r ? "loading…" : "error" in r ? r.error : `${usable} area${usable === 1 ? "" : "s"}`;
    this.regionBar.replaceChildren(
      el("span", { textContent: `Regions: ${sourceFileName(file)} · ${text}`, title: file }),
      load,
      el("button", {
        textContent: "✕",
        title: "Stop using this region file: parts are built whole again (their area picks are kept)",
        onclick: () => this.store.update((d) => void delete d.roi, "parts"),
      }),
    );
  }

  /** Cached region file info; starts loading it (and re-renders when it arrives) on first use. */
  private region(p: string): RegionState | null {
    const cached = this.regions.get(p);
    if (cached) return cached;
    if (!this.loadingRegions.has(p)) {
      this.loadingRegions.add(p);
      api.roi(this.store.doc.name, p)
        .then((info) => void this.regions.set(p, info), (err: Error) => void this.regions.set(p, { error: err.message }))
        .finally(() => {
          this.loadingRegions.delete(p);
          this.render();
        });
    }
    return null;
  }

  private async loadRegionFile(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith(".json")) return void toast("Pick a Spirula ROI region .json file.", "warn");
    let info: RoiFileInfo;
    try {
      info = await api.uploadRoi(this.store.doc.name, file.name, file);
    } catch (err) {
      return void toast(`Could not load ${file.name}: ${(err as Error).message}`, "error");
    }
    this.regions.set(info.path, info);
    this.store.update((d) => void (d.roi = info.path), "parts");
    const usable = info.outlines.filter((o) => o.usable).length;
    const changed = info.changedOutlines?.length ? ` Changed since the last copy: ${info.changedOutlines.join(", ")} (parts using them rebuild).` : "";
    toast(`${info.replaced ? "Updated" : "Loaded"} ${file.name}: ${usable} area${usable === 1 ? "" : "s"}. Tick each part's areas, save, then Build.${changed}`, "ok", 8000);
    this.show(true);
  }

  private setAreas(id: string, names: string[]): void {
    this.store.update((d) => {
      const p = d.parts.find((x) => x.id === id);
      if (!p) return;
      const sorted = sortOutlines(names);
      if (sorted.length) p.roiOutlines = sorted;
      else delete p.roiOutlines;
    }, "parts");
  }

  /** "Areas: [1] [2] [3] …" — the outlines of the part's region file it was trained on. */
  private areas(part: ScenePart, owners: Map<string, string[]>): HTMLElement | null {
    const doc = this.store.doc;
    const file = part.roi || doc.roi;
    if (!file) return null;
    const picked = outlinesOf(part);
    const own = !!part.roi && part.roi !== doc.roi;
    const label = el("span", { className: "areas-label", textContent: own ? `Areas (${sourceFileName(file)})` : "Areas", title: file });
    const r = this.region(file);
    if (!r || "error" in r) return el("div", { className: "part-areas" }, [label, el("span", { className: "muted", textContent: r ? r.error : "loading…" })]);
    const chip = (name: string, title: string, cls: string, enabled: boolean) => {
      const on = picked.includes(name);
      const box = el("input", { type: "checkbox", checked: on, disabled: !enabled && !on });
      box.addEventListener("change", () => this.setAreas(part.id, box.checked ? [...picked, name] : picked.filter((n) => n !== name)));
      return el("label", { className: `area-chip${cls}`, title }, [box, shortOutline(name)]);
    };
    const chips = r.outlines.map((o) => {
      const others = (owners.get(`${file}\n${o.name}`) ?? []).filter((id) => id !== part.id);
      const on = picked.includes(o.name);
      const shared = others.length ? (on ? `also ticked for ${others.join(", ")} (drawn by both)` : `ticked for ${others.join(", ")}`) : "";
      const title = [o.name, o.enabled ? "enabled in the file when saved" : "", o.usable ? "" : `cannot be used: ${o.error}`, shared].filter(Boolean).join(" · ");
      return chip(o.name, title, `${others.length && on ? " shared" : ""}${o.usable ? "" : " bad"}`, o.usable);
    });
    // Picked names the file no longer has: the build refuses them until unticked.
    for (const n of picked.filter((x) => !r.outlines.some((o) => o.name === x))) chips.push(chip(n, `${n} is not in ${file}: untick it (the build fails while it is picked)`, " bad", false));
    const summary = picked.length ? "" : part.roi ? "top-level region" : "none: built whole";
    return el("div", { className: "part-areas" }, [label, ...chips, summary && el("span", { className: "muted", textContent: summary })]);
  }

  private row(part: ScenePart, load: PartLoad | undefined, info: PartFileInfo | undefined, owners: Map<string, string[]>): HTMLElement {
    const doc = this.store.doc;
    const enabled = part.enabled !== false;
    const b = partBuild(doc, part.id);
    const state = load?.state ?? (enabled ? "not-built" : "disabled");
    const mode = load?.mode ?? "disabled";
    const shown = mode === "built" || mode === "source";

    const eye = el("input", { type: "checkbox", checked: shown && this.host.isVisible(part.id), disabled: !shown, title: shown ? "Show / hide in the view (not saved)" : "Not loaded" });
    eye.addEventListener("change", () => this.host.setVisible(part.id, eye.checked));

    const badges = [el("span", { className: `part-badge ${state}`, textContent: STATE_TEXT[state] ?? state })];
    if (mode === "blocked" || mode === "missing") badges.push(el("span", { className: `part-badge ${mode}`, textContent: mode === "blocked" ? "not loaded" : "missing" }));

    const actions: HTMLElement[] = [];
    if (mode === "blocked" || (mode === "source" && this.host.isPreviewed(part.id))) {
      const on = this.host.isPreviewed(part.id);
      const size = info?.bytes ?? 0;
      const fits = size <= this.host.capBytes();
      actions.push(el("button", {
        textContent: on ? "Unload" : "Preview",
        disabled: !on && !fits,
        title: on ? "Stop previewing this part's source" : fits ? `Load this part's source whole (${fmtBytes(size)}, no LoD streaming)` : "Larger than the preview cap: build it to see it",
        onclick: () => this.host.setPreviewed(part.id, !on),
      }));
    }
    if (enabled) {
      actions.push(el("button", { textContent: "Build", title: "Rebuild only this part (the others keep their build)", onclick: () => this.host.buildParts([part.id]) }));
    }
    actions.push(el("button", {
      textContent: enabled ? "Disable" : "Enable",
      title: enabled ? "Leave this part out of the scene (not built, not shown); saved with the scene" : "Put this part back into the scene",
      onclick: () => this.store.update((d) => {
        const p = d.parts.find((x) => x.id === part.id);
        if (p) p.enabled = !enabled;
      }, "parts"),
    }));
    actions.push(el("button", { textContent: "✕", className: "danger", title: "Remove this part from the scene (the source file is not touched)", onclick: () => void this.remove(part) }));

    const splats = b?.splatCount?.final ?? null;
    const meta = [
      sourceFileName(part.source),
      info ? (info.exists ? fmtBytes(info.bytes ?? 0) : "source missing") : "",
      info?.splats ? `${fmtCount(info.splats)} splats in source` : "",
      b?.crop?.keptSplats ? `cropped to ${fmtCount(b.crop.keptSplats)}${b.crop.droppedSplats !== undefined ? ` of ${fmtCount(b.crop.keptSplats + b.crop.droppedSplats)}` : ""}` : "",
      splats ? `${fmtCount(splats)} in .rad` : "",
      b?.finishedAt ? `built ${fmtTime(b.finishedAt)}${b.wallClockSeconds ? ` (${Math.round(b.wallClockSeconds)} s${b.peakMemoryBytes ? `, peak ${fmtBytes(b.peakMemoryBytes)}` : ""})` : ""}` : "",
      MODE_TEXT[mode] ?? "",
    ].filter(Boolean).join(" · ");

    return el("div", { className: `part-row${enabled ? "" : " off"}`, title: part.source }, [
      eye,
      el("span", { className: "part-name" }, [el("strong", { textContent: part.label ? `${part.label} (${part.id})` : part.id }), ...badges]),
      el("span", { className: "part-actions" }, actions),
      this.areas(part, owners),
      el("span", { className: "part-meta", textContent: meta }),
    ]);
  }

  private showAll(): void {
    for (const p of this.host.parts()) if (p.mode === "built" || p.mode === "source") this.host.setVisible(p.id, true);
    this.render();
  }

  private async remove(part: ScenePart): Promise<void> {
    const ok = await confirmDialog(
      `Remove part "${part.id}"?`,
      `It leaves the scene (save to keep the change); its build output is dropped at the next build. The source file ${part.source} is not touched.`,
      "Remove",
      true,
    );
    if (!ok) return;
    if (this.store.doc.parts.length === 1) return void toast("A scene needs at least one part.", "warn");
    this.store.update((d) => (d.parts = d.parts.filter((p) => p.id !== part.id)), "parts");
  }

  private async addParts(): Promise<void> {
    let files: { path: string; bytes: number }[];
    let dir = "assets/source_ply";
    try {
      const r = await api.sources();
      files = r.files;
      dir = r.dir;
    } catch (err) {
      return void toast(`Could not list sources: ${(err as Error).message}`, "error");
    }
    const have = new Set(this.store.doc.parts.map((p) => p.source));
    const free = files.filter((f) => !have.has(f.path));
    if (free.length === 0) return void toast(`Every file in ${dir}/ is already a part of this scene.`, "info");
    const picker = sourcePicker(free);
    const ok = await dialog({
      title: "Add parts",
      body: [
        el("p", { textContent: "Pick source files that are in the SAME coordinate frame as this scene's other parts (e.g. the other parts of a Spirula Studio export). They get the scene transform as it is." }),
        picker.root,
      ],
      buttons: [
        { label: "Cancel", value: false },
        { label: "Add", value: true, primary: true, enabled: () => picker.selected().length > 0 },
      ],
      cancelValue: false,
    });
    if (!ok) return;
    const sources = picker.selected();
    this.store.update((d) => {
      const taken = new Set(d.parts.map((p) => p.id.toLowerCase()));
      for (const source of sources) {
        const id = partIdFromSource(source, taken);
        taken.add(id.toLowerCase());
        d.parts.push({ id, source, enabled: true });
      }
    }, "parts");
    toast(`Added ${sources.length} part${sources.length === 1 ? "" : "s"}: save, then Build.`, "ok");
  }
}

/** Checkbox list of source files (shared with the New scene dialog). */
export function sourcePicker(files: { path: string; bytes: number }[], initial: string[] = []): { root: HTMLElement; selected: () => string[]; onChange: (fn: () => void) => void } {
  const boxes: [HTMLInputElement, string][] = [];
  const listeners: (() => void)[] = [];
  const total = el("div", { className: "panel-note" });
  const sync = () => {
    const sel = boxes.filter(([b]) => b.checked).map(([, p]) => p);
    const bytes = files.filter((f) => sel.includes(f.path)).reduce((s, f) => s + f.bytes, 0);
    total.textContent = sel.length ? `${sel.length} selected, ${fmtBytes(bytes)}` : "Nothing selected";
    for (const fn of listeners) fn();
  };
  const rows = files.map((f) => {
    const box = el("input", { type: "checkbox", checked: initial.includes(f.path) });
    box.addEventListener("change", sync);
    boxes.push([box, f.path]);
    return el("label", { title: f.path }, [box, el("span", { textContent: f.path.replace(/^assets\/source_ply\//, "") }), el("span", { className: "src-size", textContent: fmtBytes(f.bytes) })]);
  });
  const root = el("div", {}, [el("div", { className: "source-picker" }, rows), total]);
  sync();
  return {
    root,
    selected: () => boxes.filter(([b]) => b.checked).map(([, p]) => p),
    onChange: (fn) => listeners.push(fn),
  };
}
