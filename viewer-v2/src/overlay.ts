/**
 * Performance overlay + status cards. Plain DOM, no framework. Phase 3 tour
 * UI (info panels, loading states) should live in its own module and leave
 * this one as a debug/test tool toggled with ?overlay=0/1 or the P key.
 */
import { buildResults, SPARK_VERSION } from "./results";
import { isTypingTarget } from "./ui/dom";
import type { Viewer } from "./viewer";

const fmtCount = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n);
const fmtMs = (v: number | null): string => (v === null ? "—" : `${(v / 1000).toFixed(2)} s`);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

/** Clipboard API needs a secure context (not plain-http LAN); fall back to execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = el("textarea", { value: text });
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export class Overlay {
  private readonly panel: HTMLDivElement;
  private readonly body: HTMLPreElement;
  private readonly toast: HTMLDivElement;
  private readonly showButton: HTMLButtonElement;
  private readonly controlsButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private visible: boolean;

  constructor(
    private readonly root: HTMLElement,
    private readonly viewer: Viewer,
  ) {
    this.visible = viewer.config.overlay;
    this.body = el("pre", { className: "perf-body" });
    this.controlsButton = el("button", { onclick: () => this.toggleControls() });
    this.saveButton = el("button", {
      textContent: "Save to reports/",
      title: "Dev server only: writes reports/raw/<time>_<device>.json",
      hidden: true,
      onclick: () => void this.save(),
    });
    const buttons = el("div", { className: "perf-buttons" }, [
      el("button", { textContent: "Copy results JSON", onclick: () => void this.copy() }),
      this.saveButton,
      el("button", { textContent: "Reset fps stats", title: "Start a new measurement window (R)", onclick: () => this.resetStats() }),
      this.controlsButton,
      el("button", { textContent: "Reset view", title: "Back to start viewpoint (V)", onclick: () => viewer.resetView() }),
      el("button", { textContent: "Hide", title: "Toggle overlay (P)", onclick: () => this.setVisible(false) }),
    ]);
    this.panel = el("div", { className: "perf-panel" }, [this.body, buttons]);
    this.showButton = el("button", { className: "perf-show", textContent: "Stats", onclick: () => this.setVisible(true) });
    this.toast = el("div", { className: "toast", hidden: true });
    root.append(this.panel, this.showButton, this.toast);
    this.setVisible(this.visible);
    this.updateControlsLabel();

    window.addEventListener("keydown", (e) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyP") this.setVisible(!this.visible);
      else if (e.code === "KeyC") this.toggleControls();
      else if (e.code === "KeyR") this.resetStats();
      else if (e.code === "KeyV") viewer.resetView();
    });

    // "Save to reports/" only works against the Vite dev/preview server.
    fetch("/__models", { method: "GET", cache: "no-store" })
      .then((r) => {
        if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) this.saveButton.hidden = false;
      })
      .catch(() => undefined);

    window.setInterval(() => this.render(), 250);
    this.render();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.panel.hidden = !v;
    this.showButton.hidden = v;
  }

  private toggleControls(): void {
    this.viewer.rig.toggleMode();
    this.updateControlsLabel();
  }

  private updateControlsLabel(): void {
    this.controlsButton.textContent = `Controls: ${this.viewer.rig.mode} (C)`;
  }

  private resetStats(): void {
    this.viewer.frames.resetMeasurement();
    this.flash("FPS measurement window reset");
  }

  private async copy(): Promise<void> {
    const json = JSON.stringify(buildResults(this.viewer), null, 2);
    if (await copyText(json)) this.flash("Results copied to clipboard");
    else showTextDialog(this.root, "Copy these results", json);
  }

  private async save(): Promise<void> {
    try {
      const res = await fetch("/__results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildResults(this.viewer)),
      });
      const out = (await res.json()) as { ok: boolean; file?: string; error?: string };
      this.flash(out.ok ? `Saved ${out.file}` : `Save failed: ${out.error}`);
    } catch (err) {
      this.flash(`Save failed: ${(err as Error).message}`);
    }
  }

  private flash(msg: string): void {
    this.toast.textContent = msg;
    this.toast.hidden = false;
    window.clearTimeout((this.toast as unknown as { _t?: number })._t);
    (this.toast as unknown as { _t?: number })._t = window.setTimeout(() => (this.toast.hidden = true), 2500);
  }

  private render(): void {
    if (!this.visible) return;
    const v = this.viewer;
    const live = v.frames.live();
    const meas = v.frames.measurement();
    const t = v.timeline;
    const net = v.network.get();
    const drawn = v.spark.activeSplats;
    const pager = v.spark.pager;
    const ranges = v.models.map((m) => m.preflight.range);
    const plainMB = v.models.reduce((sum, m) => sum + (m.paged ? 0 : m.bytesLoaded), 0) / 1e6;
    const lines = [
      `FPS        ${live.avgFps.toFixed(1)}  (1% low ${live.onePctLowFps.toFixed(1)})`,
      `Frame      ${live.avgFrameMs.toFixed(2)} ms  (max ${live.maxFrameMs.toFixed(1)})`,
      `Measured   ${meas.avgFps.toFixed(1)} fps, 1% low ${meas.onePctLowFps.toFixed(1)}  over ${meas.durationS.toFixed(0)} s`,
      `Splats     ${fmtCount(drawn)} / ${fmtCount(v.budget)}  (${v.budgetSource})`,
      `Device     ${v.device.profile.id}${v.device.forced ? ` (forced; detected ${v.device.detected})` : ""}  px ${v.pixelRatio.toFixed(2)}`,
      `1st splat  ${fmtMs(t.firstSplatFrameMs)}`,
      `LoD        ${t.status}${t.settledMs !== null ? `  settled ${fmtMs(t.settledMs)}` : ""}${t.interactedBeforeSettle ? "  (moved first)" : ""}`,
      `Network    ${net.requests} req, ${(net.bodyBytes / 1e6 + plainMB).toFixed(1)} MB${pager ? `, ${pager.isFetching() ? "fetching" : "idle"}` : ""}`,
      ...(ranges.length ? [`Range      ${ranges.join(", ")}`] : []),
      `Spark ${SPARK_VERSION}`,
      ...v.device.notes.map((n) => `! ${n}`),
    ];
    this.body.textContent = lines.join("\n");
  }
}

/** Modal with selectable text, for when clipboard copy is unavailable. */
export function showTextDialog(root: HTMLElement, title: string, text: string): void {
  const ta = el("textarea", { value: text, readOnly: true });
  const close = el("button", { textContent: "Close" });
  const dialog = el("div", { className: "dialog" }, [el("h2", { textContent: title }), ta, close]);
  const backdrop = el("div", { className: "backdrop" }, [dialog]);
  close.onclick = () => backdrop.remove();
  root.append(backdrop);
  ta.focus();
  ta.select();
}

/** Centered card for "no model" / "failed to load" states. */
export function showMessage(root: HTMLElement, opts: { title: string; lines: string[]; error?: boolean }): HTMLDivElement {
  const card = el("div", { className: `message${opts.error ? " error" : ""}` }, [
    el("h1", { textContent: opts.title }),
    ...opts.lines.map((l) => el("p", { textContent: l })),
  ]);
  root.append(card);
  return card;
}

/** Fill a message card with links to models found by the dev server. */
export async function appendModelPicker(card: HTMLElement): Promise<void> {
  try {
    const res = await fetch("/__models", { cache: "no-store" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
    const files = (await res.json()) as { url: string; bytes: number }[];
    if (files.length === 0) {
      card.append(el("p", { textContent: "No model files found in assets/rad_output or assets/source_ply yet." }));
      return;
    }
    const list = el("ul");
    for (const f of files) {
      const params = new URLSearchParams(window.location.search);
      params.set("model", decodeURIComponent(f.url));
      const a = el("a", { href: `?${params.toString()}`, textContent: decodeURIComponent(f.url) });
      list.append(el("li", {}, [a, ` (${(f.bytes / 1e6).toFixed(1)} MB)`]));
    }
    card.append(el("p", { textContent: "Models available on this dev server:" }), list);
  } catch {
    /* not on the dev server; nothing to list */
  }
}
