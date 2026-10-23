/**
 * Entry point. Routes:
 *   (no params)           start page: the scene list (src/scene/startPage.ts)
 *   ?scene=<name>         scene editor: scenes/<name>/scene.json + its built .rad
 *                         (or the source when unbuilt), see src/scene/editor.ts
 *   ?model=<url> / ?config=<json>   v1-style debug viewer (no save / build)
 * A published build (VITE_STATIC=1, scene/published.ts) has no dev server: the
 * start page lists scenes/index.json and ?scene= opens the scene view-only.
 */
import "./style.css";
import { validateScene, type SceneDoc } from "../../shared/scene-schema.mjs";
import { AlignMode, localAlignBinding } from "./align/alignMode";
import { runOrbitBenchmark, type BenchOptions } from "./bench";
import { loadConfig, type ViewerConfigFile } from "./config";
import { resolveDevice } from "./device";
import { attachNavigation } from "./nav";
import { appendModelPicker, Overlay, showMessage } from "./overlay";
import { PlanMode } from "./plan/planMode";
import { api, fetchSceneJson } from "./scene/api";
import { SceneEditor } from "./scene/editor";
import { previewCapBytes, sceneCamera, sceneModels, sceneNavigation, type PartFileInfo, type SceneModels } from "./scene/sceneConfig";
import { PUBLISHED, PublishedIndex, publishedChrome } from "./scene/published";
import { StartPage } from "./scene/startPage";
import { el, fmtBytes, guardTyping } from "./ui/dom";
import { Viewer } from "./viewer";

const backLink = () => el("p", {}, [el("a", { href: "./", textContent: "← Back to the scene list" })]);

/** scenes/<name>/scene.json -> scene doc + what to load for each part. */
async function openScene(name: string): Promise<{ scene: SceneDoc; load: SceneModels; info: PartFileInfo[] | null; base: ViewerConfigFile }> {
  const { scene, errors } = validateScene(await fetchSceneJson(name));
  if (!scene) throw new Error(`scenes/${name}/scene.json is invalid: ${errors.join("; ")}`);
  if (scene.name !== name) throw new Error(`scenes/${name}/scene.json says name "${scene.name}"`);
  // Which .rad files are really on disk (build/ is gitignored) and how big the sources are (preview cap).
  let info: PartFileInfo[] | null = null;
  if (!PUBLISHED) {
    try {
      info = await api.info(name);
    } catch (err) {
      console.warn("scene info unavailable; assuming recorded builds exist", err);
    }
  }
  const load = sceneModels(scene, info, { capBytes: previewCapBytes(window.location.search) });
  let camera = sceneCamera(scene);
  if (!camera && load.plan.refMatrix && scene.build?.bounds) {
    // Paged models can't be auto-framed (no CPU-side splats yet): frame the build bounds.
    const { bboxMin: a, bboxMax: b } = scene.build.bounds;
    const c: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const r = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2;
    camera = { position: [c[0], c[1] + r * 0.3, c[2] + r * 1.2], target: c };
  }
  return {
    scene,
    load,
    info,
    // Published tours start without the performance overlay (P or ?overlay=1 shows it) and on
    // Gaussian Splat Lite (?renderer=spark switches back; reports/benchmarks/2026-10-23-spark-vs-gsl).
    base: {
      models: load.models,
      camera,
      navigation: sceneNavigation(scene),
      controls: "orbit",
      ...(PUBLISHED && { overlay: false, renderer: "gsl" as const }),
    },
  };
}

async function main(): Promise<void> {
  const app = document.getElementById("app");
  const ui = document.getElementById("ui");
  if (!app || !ui) throw new Error("index.html is missing #app / #ui");
  // #app is a fixed full-screen layer; until it holds a canvas it would swallow clicks on the start page / error cards.
  app.hidden = true;

  const q = new URLSearchParams(window.location.search);
  const sceneName = q.get("scene");
  if (!sceneName && q.getAll("model").length === 0 && !q.get("config")) {
    if (PUBLISHED) new PublishedIndex(ui);
    else new StartPage(ui);
    return;
  }

  let opened: Awaited<ReturnType<typeof openScene>> | null = null;
  if (sceneName) {
    try {
      opened = await openScene(sceneName);
    } catch (err) {
      const card = showMessage(ui, { title: `Scene "${sceneName}" could not be opened`, lines: [(err as Error).message], error: true });
      card.append(backLink());
      return;
    }
  }

  let config;
  try {
    config = await loadConfig(window.location.search, opened?.base);
  } catch (err) {
    showMessage(ui, { title: "Config failed to load", lines: [(err as Error).message], error: true });
    return;
  }

  const device = resolveDevice(config.device);

  let viewer: Viewer;
  try {
    app.hidden = false;
    viewer = await Viewer.create(app, config, device);
  } catch (err) {
    // Typically: WebGL2 unavailable (or WebGPU on ?renderer=gsl).
    app.hidden = true;
    showMessage(ui, { title: "Renderer failed to start", lines: [(err as Error).message], error: true });
    return;
  }
  // Exposed for console debugging and future automation (e.g. scripted test routes).
  const w = window as unknown as Record<string, unknown>;
  w.viewer = viewer;
  w.bench = (opts?: BenchOptions) => runOrbitBenchmark(viewer, opts);

  new Overlay(ui, viewer);

  if (opened && PUBLISHED) {
    guardTyping(ui);
    attachNavigation(viewer, ui);
    publishedChrome(viewer, ui, opened.scene.name);
  } else if (opened) {
    const editor = new SceneEditor(viewer, ui, opened.scene, opened.load, opened.info);
    Object.assign(w, { editor, store: editor.store, align: editor.align, plan: editor.plan });
  } else {
    // Debug viewer (?model= / ?config=): v1 behaviour, previews only.
    guardTyping(ui);
    document.body.classList.add("no-topbar");
    const dock = el("div", { className: "dock" });
    ui.append(dock);
    attachNavigation(viewer, ui);
    const plan = new PlanMode(ui, viewer, { dock });
    w.plan = plan;
    w.align = new AlignMode(ui, viewer, localAlignBinding(viewer), [plan], dock);
  }

  // No model is fine when starting in first-person (navigation testing, e.g. configs/nav-test.json).
  if (config.models.length === 0 && config.controls === "walk") return;
  if (opened && config.models.length === 0) {
    // Unbuilt and over the preview cap (or every part disabled / missing): the editor's banner explains.
    const p = opened.load.plan;
    const card = showMessage(ui, {
      title: p.overCap ? "Build to preview" : "Nothing to show",
      lines: p.overCap
        ? [
          `The scene is not built and its sources add up to ${fmtBytes(p.unbuiltBytes)}, more than the ${fmtBytes(previewCapBytes(window.location.search))} that is loaded whole into the browser.`,
          "Build it (streams with LoD), or preview single parts from Parts (L). ?previewCapGB=<n> raises the cap.",
        ]
        : ["Every part is disabled or its source is missing: see Parts (L)."],
    });
    window.setTimeout(() => card.remove(), 15000);
    return;
  }
  if (config.models.length === 0) {
    const card = showMessage(ui, {
      title: "No model specified",
      lines: [
        "Add ?model=<url> to the address, e.g.",
        "?model=/models/<name>/<version>/<stem>-lod.rad   (streamed, paged LoD)",
        "?model=/source/<file>.ply  (or .spz / .sog, loaded whole)",
        "Or open a scene from the scene list.",
      ],
    });
    card.append(backLink());
    void appendModelPicker(card);
    return;
  }

  const loading = showMessage(ui, {
    title: opened?.load.mode === "source" ? "Loading the source (whole, not streamed)…" : opened?.load.mode === "mixed" ? "Loading (unbuilt parts load whole)…" : "Loading…",
    lines: config.models.map((m) => decodeURIComponent(m.url.split("?")[0])),
  });
  loading.classList.add("loading");
  await viewer.loadModels();
  loading.remove();

  if (viewer.errors.length > 0) {
    const allFailed = viewer.models.length === 0;
    const card = showMessage(ui, {
      title: allFailed ? "Model failed to load" : "Some models failed to load",
      lines: viewer.errors,
      error: true,
    });
    if (opened) card.append(backLink());
    else if (allFailed) void appendModelPicker(card);
    if (!allFailed) window.setTimeout(() => card.remove(), 8000);
  }
}

void main();
