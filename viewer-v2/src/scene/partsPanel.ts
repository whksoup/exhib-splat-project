/**
 * Parts panel (L): the scene's source parts with their build state, splat
 * counts and sizes; show / hide each part in the view (not saved), enable or
 * disable it (saved: disabled parts are neither built nor shown), add parts
 * from assets/source_ply, remove parts, preview an unbuilt part when the scene
 * is over the preview size cap, and rebuild a single part.
 *
 * All parts share the scene transform (Align moves them together).
 */
import { partIdFromSource, partBuild, sourceFileName, type PartLoad, type ScenePart } from "../../../shared/scene-schema.mjs";
import { confirmDialog, dialog, el, fmtBytes, fmtCount, fmtTime, toast } from "../ui/dom";
import { api } from "./api";
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

export class PartsPanel {
  readonly panel: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly note: HTMLDivElement;

  constructor(
    private readonly store: SceneStore,
    private readonly host: PartsHost,
  ) {
    this.list = el("div", { className: "parts-list" });
    this.note = el("div", { className: "panel-note" });
    const title = el("strong", { textContent: "Parts" });
    this.panel = el("div", { className: "plan-panel parts-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [title, el("button", { textContent: "Close", title: "Hide (L)", onclick: () => this.show(false) })]),
      this.note,
      this.list,
      el("div", { className: "plan-row" }, [
        el("button", { textContent: "+ Add parts…", title: "Add source files from assets/source_ply (same coordinate frame as the other parts)", onclick: () => void this.addParts() }),
        el("button", { textContent: "↻", title: "Re-read file sizes and build state", onclick: () => void this.host.refresh() }),
        el("button", { textContent: "Show all", onclick: () => this.showAll() }),
      ]),
    ]);
    title.addEventListener("click", () => this.panel.classList.toggle("collapsed"));
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
    this.list.replaceChildren(...doc.parts.map((p) => this.row(p, plan.get(p.id), info.get(p.id))));
  }

  private row(part: ScenePart, load: PartLoad | undefined, info: PartFileInfo | undefined): HTMLElement {
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
      splats ? `${fmtCount(splats)} in .rad` : "",
      b?.finishedAt ? `built ${fmtTime(b.finishedAt)}${b.wallClockSeconds ? ` (${Math.round(b.wallClockSeconds)} s${b.peakMemoryBytes ? `, peak ${fmtBytes(b.peakMemoryBytes)}` : ""})` : ""}` : "",
      MODE_TEXT[mode] ?? "",
    ].filter(Boolean).join(" · ");

    return el("div", { className: `part-row${enabled ? "" : " off"}`, title: part.source }, [
      eye,
      el("span", { className: "part-name" }, [el("strong", { textContent: part.label ? `${part.label} (${part.id})` : part.id }), ...badges]),
      el("span", { className: "part-actions" }, actions),
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
