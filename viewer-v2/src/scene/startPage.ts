/**
 * Start page (no ?scene= / ?model=): the scene list with Open, New, Duplicate
 * and Delete. Scenes are save files in scenes/<name>/; see dev-server/scenes.ts.
 */
import { isValidSceneName } from "../../../shared/scene-schema.mjs";
import { appendModelPicker } from "../overlay";
import { dialog, el, fmtBytes, fmtCount, fmtTime, toast } from "../ui/dom";
import { api, type SceneListEntry } from "./api";
import { sourcePicker } from "./partsPanel";

const sceneHref = (name: string) => `?${new URLSearchParams({ scene: name })}`;

/** Live-validated scene name field. `taken` are existing names. */
function nameField(taken: Set<string>, initial = ""): { input: HTMLInputElement; msg: HTMLDivElement; valid: () => boolean } {
  const input = el("input", { type: "text", value: initial, spellcheck: false, autocomplete: "off", placeholder: "e.g. office_floor2" });
  const msg = el("div", { className: "field-msg" });
  const problem = (): string | null => {
    const v = input.value.trim();
    if (!v) return "Letters, digits, _ and - (max 64). Becomes the folder scenes/<name>/.";
    if (!isValidSceneName(v)) return "Only letters, digits, _ and - (must start with a letter or digit, max 64).";
    if (taken.has(v.toLowerCase())) return `A scene called "${v}" already exists.`;
    return null;
  };
  const sync = () => {
    const p = problem();
    msg.textContent = p ?? `Will create scenes/${input.value.trim()}/`;
    msg.classList.toggle("bad", !!p && input.value.trim() !== "");
  };
  input.addEventListener("input", sync);
  sync();
  return { input, msg, valid: () => problem() === null };
}

export class StartPage {
  private readonly root: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private scenes: SceneListEntry[] = [];
  private timer = 0;

  constructor(host: HTMLElement) {
    document.body.classList.add("start-page");
    document.title = "Scenes · Splat Tour Editor";
    this.grid = el("div", { className: "scene-grid" });
    const picker = el("details", {}, [el("summary", { textContent: "Debug: open a model file directly (?model=)" })]);
    picker.addEventListener("toggle", () => {
      if (picker.open && picker.childElementCount === 1) void appendModelPicker(picker);
    }, { once: false });
    this.root = el("div", { className: "start" }, [
      el("header", {}, [
        el("h1", { textContent: "Scenes" }),
        el("button", { textContent: "Refresh", onclick: () => void this.refresh() }),
        el("button", { className: "primary", textContent: "+ New scene", onclick: () => void this.newScene() }),
      ]),
      el("p", { className: "sub", textContent: "Each scene is a save file in scenes/<name>/: the source it references, its alignment, navigation and build." }),
      this.grid,
      picker,
    ]);
    host.append(this.root);
    void this.refresh();
    // Keep build status fresh (a build may be running from another tab or build-scene.bat).
    this.timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !document.querySelector(".modal-backdrop")) void this.refresh(true);
    }, 5000);
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.root.remove();
  }

  private async refresh(quiet = false): Promise<void> {
    try {
      this.scenes = await api.list();
      this.render();
    } catch (err) {
      if (!quiet) {
        this.grid.replaceChildren(
          el("div", { className: "empty" }, [
            el("p", { textContent: `Could not list scenes: ${(err as Error).message}` }),
            el("p", { textContent: "The scene editor needs the viewer-v2 dev server (npm run dev in viewer-v2/)." }),
          ]),
        );
      }
    }
  }

  private render(): void {
    if (this.scenes.length === 0) {
      this.grid.replaceChildren(
        el("div", { className: "empty" }, [
          el("p", { textContent: "No scenes yet." }),
          el("button", { className: "primary", textContent: "+ New scene", onclick: () => void this.newScene() }),
        ]),
      );
      return;
    }
    this.grid.replaceChildren(...this.scenes.map((s) => this.card(s)));
  }

  private card(s: SceneListEntry): HTMLElement {
    if (s.error) {
      return el("div", { className: "scene-card" }, [
        el("h2", { textContent: s.name }),
        el("div", { className: "flags" }, [el("span", { className: "flag bad", textContent: "unreadable scene.json" })]),
        el("p", { className: "panel-note bad", textContent: s.error }),
        el("div", { className: "actions" }, [el("button", { className: "danger", textContent: "Delete…", onclick: () => void this.remove(s) })]),
      ]);
    }
    const flags: HTMLElement[] = [];
    const flag = (text: string, cls: string, title = "") => flags.push(el("span", { className: `flag ${cls}`, textContent: text, title }));
    const sum = s.summary;
    if (s.building) flag("building…", "run");
    if (s.built && (!sum || sum.complete)) flag("built", "ok");
    else if (s.built && sum) flag(`built ${sum.built}/${sum.enabled} parts`, "warn", "Build to finish the other parts (built parts are reused)");
    else flag("not built", "warn", "Opens a plain preview of the source (if small enough); build to stream it with LoD");
    if (s.buildAttempt?.status === "failed") flag("last build failed", "bad", s.buildAttempt.error ?? "");
    if (s.transformChanged) flag("transform changed since build", "warn", "Build to apply the new alignment");
    if (s.navWarning) flag("nav may be misaligned", "bad", "Navigation assets were authored for a different transform");
    if (s.sourceExists === false) flag("source missing", "bad", s.source ?? "");

    const attempt = s.buildAttempt;
    const lastBuild = s.build
      ? `${fmtTime(s.build.finishedAt)}${s.build.wallClockSeconds ? ` (${Math.round(s.build.wallClockSeconds)} s${s.build.peakMemoryBytes ? `, peak ${fmtBytes(s.build.peakMemoryBytes)}` : ""})` : ""}`
      : "never";
    const parts = s.parts ?? [];
    const sourceText = parts.length > 1
      ? `${parts.length} parts: ${parts.map((p) => p.id + (p.enabled ? "" : " (off)")).join(", ")}`
      : (s.source ?? "—");
    return el("div", { className: "scene-card" }, [
      el("h2", {}, [el("a", { href: sceneHref(s.name), textContent: s.name })]),
      el("div", { className: "flags" }, flags),
      el("dl", {}, [
        el("dt", { textContent: parts.length > 1 ? "Parts" : "Source" }),
        el("dd", { textContent: sourceText, title: parts.map((p) => p.source).join("\n") }),
        el("dt", { textContent: "Last build" }),
        el("dd", { textContent: lastBuild }),
        el("dt", { textContent: "Status" }),
        el("dd", {
          textContent: attempt ? `${attempt.status === "ok" ? "ok" : `failed: ${attempt.error ?? "?"}`} · ${fmtTime(attempt.finishedAt)}` : "—",
        }),
        el("dt", { textContent: "Splats" }),
        el("dd", {
          textContent: s.build?.splatCount
            ? `${fmtCount(s.build.splatCount.final)} in .rad (source ${fmtCount(s.build.splatCount.input)})`
            : "—",
        }),
        el("dt", { textContent: "Nav files" }),
        el("dd", { textContent: String(s.navFiles ?? 0) }),
      ]),
      el("div", { className: "actions" }, [
        el("button", { className: "primary open", textContent: "Open", onclick: () => (window.location.href = sceneHref(s.name)) }),
        el("button", { textContent: "Duplicate…", title: "Copy scene.json and nav/ (not the build)", onclick: () => void this.duplicate(s) }),
        el("button", { className: "danger", textContent: "Delete…", title: "Remove scenes/<name>/ (never the source)", onclick: () => void this.remove(s) }),
      ]),
    ]);
  }

  private taken(): Set<string> {
    return new Set(this.scenes.map((s) => s.name.toLowerCase()));
  }

  private async newScene(): Promise<void> {
    let sources: { path: string; bytes: number }[] = [];
    let dir = "assets/source_ply";
    try {
      const r = await api.sources();
      sources = r.files;
      dir = r.dir;
    } catch (err) {
      toast(`Could not list sources: ${(err as Error).message}`, "error");
      return;
    }
    if (sources.length === 0) {
      toast(`No source files in ${dir}/. Put a .ply / .sog / .spz there first.`, "warn");
      return;
    }
    const clean = (s: string) => s.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+/, "").slice(0, 64).toLowerCase();
    /** One file: its stem. Several in one folder: the folder name ("parts/OculusV1/part*.ply" -> "oculusv1"). */
    const suggest = (paths: string[]): string => {
      if (paths.length === 0) return "";
      if (paths.length === 1) return clean(paths[0].slice(paths[0].lastIndexOf("/") + 1));
      const dirs = new Set(paths.map((p) => p.slice(0, p.lastIndexOf("/"))));
      if (dirs.size === 1) {
        const d = [...dirs][0];
        const folder = d.slice(d.lastIndexOf("/") + 1);
        if (folder && folder !== "source_ply") return clean(folder);
      }
      return `${clean(paths[0].slice(paths[0].lastIndexOf("/") + 1))}_parts`.slice(0, 64);
    };
    const picker = sourcePicker(sources, [sources[0].path]);
    const field = nameField(this.taken(), suggest(picker.selected()));
    let touched = false;
    field.input.addEventListener("input", (e) => {
      if (e.isTrusted) touched = true;
    });
    picker.onChange(() => {
      if (touched) return;
      field.input.value = suggest(picker.selected());
      field.input.dispatchEvent(new Event("input"));
    });
    const ok = await dialog({
      title: "New scene",
      body: [
        el("label", { textContent: `Sources (${dir}/, referenced, never copied or modified)` }),
        el("p", { className: "panel-note", textContent: "Pick one file, or several parts of one scan in the same coordinate frame (e.g. the parts Spirula Studio trained separately): each becomes a part, built on its own and shown together." }),
        picker.root,
        el("label", { textContent: "Scene name" }),
        field.input,
        field.msg,
      ],
      buttons: [
        { label: "Cancel", value: false },
        { label: "Create and open", value: true, primary: true, enabled: () => field.valid() && picker.selected().length > 0 },
      ],
      cancelValue: false,
      focus: field.input,
    });
    if (!ok) return;
    const name = field.input.value.trim();
    try {
      await api.create(name, picker.selected());
      window.location.href = sceneHref(name);
    } catch (err) {
      toast(`Create failed: ${(err as Error).message}`, "error");
    }
  }

  private async duplicate(s: SceneListEntry): Promise<void> {
    const field = nameField(this.taken(), `${s.name}_copy`.slice(0, 64));
    const ok = await dialog({
      title: `Duplicate "${s.name}"`,
      body: [
        el("p", { textContent: "Copies scene.json and nav/. The build is not copied: the copy starts unbuilt." }),
        el("label", { textContent: "New scene name" }),
        field.input,
        field.msg,
      ],
      buttons: [
        { label: "Cancel", value: false },
        { label: "Duplicate", value: true, primary: true, enabled: field.valid },
      ],
      cancelValue: false,
      focus: field.input,
    });
    if (!ok) return;
    try {
      await api.duplicate(s.name, field.input.value.trim());
      toast(`Duplicated ${s.name} → ${field.input.value.trim()}`, "ok");
      await this.refresh();
    } catch (err) {
      toast(`Duplicate failed: ${(err as Error).message}`, "error");
    }
  }

  private async remove(s: SceneListEntry): Promise<void> {
    const input = el("input", { type: "text", spellcheck: false, autocomplete: "off", placeholder: s.name });
    const ok = await dialog({
      title: `Delete "${s.name}"?`,
      body: [
        el("p", { textContent: `This removes scenes/${s.name}/ (scene.json, nav/ and build/). It cannot be undone.` }),
        el("p", { textContent: `The source file is never touched${s.source ? `: ${s.source}` : ""}.` }),
        el("label", { textContent: `Type ${s.name} to confirm` }),
        input,
      ],
      buttons: [
        { label: "Cancel", value: false },
        { label: "Delete scene", value: true, danger: true, enabled: () => input.value === s.name },
      ],
      cancelValue: false,
      focus: input,
    });
    if (!ok) return;
    try {
      await api.remove(s.name, input.value);
      toast(`Deleted scene ${s.name}`, "ok");
      await this.refresh();
    } catch (err) {
      toast(`Delete failed: ${(err as Error).message}`, "error");
    }
  }
}
