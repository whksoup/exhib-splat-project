/**
 * Published (static) build: `VITE_STATIC=1 vite build`, assembled for a static
 * host by scripts/publish-static.mjs. There is no dev server, so:
 *   (no params)    a landing page listing scenes/index.json (written by the publish script)
 *   ?scene=<name>  the scene, view-only: camera modes, walk navigation and the
 *                  Speed / Detail sliders; no Save, Build, Align, Parts or Plan.
 */
import { el, fmtBytes, fmtCount } from "../ui/dom";
import type { Viewer } from "../viewer";
import { viewSliders } from "./viewSliders";

export const PUBLISHED = import.meta.env.VITE_STATIC === "1";

/** One entry of scenes/index.json. */
export interface PublishedScene {
  name: string;
  title?: string;
  parts: number;
  splats: number | null;
  bytes: number;
  builtAt: string | null;
}

const sceneHref = (name: string) => `?scene=${encodeURIComponent(name)}`;

export class PublishedIndex {
  constructor(host: HTMLElement) {
    document.body.classList.add("start-page");
    document.title = "Splat tours";
    const grid = el("div", { className: "scene-grid" });
    host.append(
      el("div", { className: "start" }, [
        el("header", {}, [el("h1", { textContent: "Splat tours" })]),
        el("p", { className: "sub", textContent: "Gaussian-splat scans streamed with level of detail. Best on a desktop GPU; detail sharpens as you look around." }),
        grid,
      ]),
    );
    void this.load(grid);
  }

  private async load(grid: HTMLElement): Promise<void> {
    let scenes: PublishedScene[];
    try {
      const res = await fetch("scenes/index.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`scenes/index.json: HTTP ${res.status}`);
      scenes = (await res.json()) as PublishedScene[];
    } catch (err) {
      grid.replaceChildren(el("div", { className: "empty" }, [el("p", { textContent: `Could not list the tours: ${(err as Error).message}` })]));
      return;
    }
    if (scenes.length === 0) {
      grid.replaceChildren(el("div", { className: "empty" }, [el("p", { textContent: "No tours published yet." })]));
      return;
    }
    grid.replaceChildren(
      ...scenes.map((s) =>
        el("div", { className: "scene-card" }, [
          el("h2", {}, [el("a", { href: sceneHref(s.name), textContent: s.title ?? s.name })]),
          el("dl", {}, [
            el("dt", { textContent: "Splats" }),
            el("dd", { textContent: s.splats ? fmtCount(s.splats) : "—" }),
            el("dt", { textContent: "Streamed data" }),
            el("dd", { textContent: `${fmtBytes(s.bytes)} in ${s.parts} part${s.parts === 1 ? "" : "s"} (only what the view needs is downloaded)` }),
          ]),
          el("div", { className: "actions" }, [el("button", { className: "primary open", textContent: "Open", onclick: () => (window.location.href = sceneHref(s.name)) })]),
        ]),
      ),
    );
  }
}

const MODE_LABEL: Record<string, string> = { orbit: "Orbit", fly: "Fly", walk: "Walk" };

/** Top bar of a published scene: back to the list, camera mode, Speed / Detail. */
export function publishedChrome(viewer: Viewer, ui: HTMLElement, sceneName: string): void {
  document.title = `${sceneName} · Splat tour`;
  const mode = el("button", { title: "Camera: orbit / fly / walk (C cycles)", onclick: () => viewer.rig.toggleMode() });
  const sync = () => (mode.textContent = MODE_LABEL[viewer.rig.mode] ?? viewer.rig.mode);
  sync();
  // The overlay's C shortcut also cycles the mode: keep the label honest.
  window.setInterval(sync, 400);
  ui.append(
    el("div", { className: "topbar" }, [
      el("a", { className: "home", href: "./", textContent: "← Tours", title: "Back to the list" }),
      el("span", { className: "scene-name", textContent: sceneName }),
      el("span", { className: "sep" }),
      mode,
      viewSliders(viewer),
      el("span", { className: "spacer" }),
    ]),
  );
}
