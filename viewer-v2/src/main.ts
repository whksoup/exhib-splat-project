/**
 * Entry point. Routes:
 *   (no params)           start page: the scene list (src/scene/startPage.ts)
 *   ?scene=<name>         scene editor: scenes/<name>/scene.json + its built .rad
 *                         (or the source when unbuilt), see src/scene/editor.ts
 *   ?model=<url> / ?config=<json>   v1-style debug viewer (no save / build)
 */
import "./style.css";
import { validateScene, type SceneDoc } from "../../shared/scene-schema.mjs";
import { AlignMode, localAlignBinding } from "./align/alignMode";
import { loadConfig, type ViewerConfigFile } from "./config";
import { resolveDevice } from "./device";
import { attachNavigation } from "./nav";
import { appendModelPicker, Overlay, showMessage } from "./overlay";
import { PlanMode } from "./plan/planMode";
import { fetchSceneJson, urlExists } from "./scene/api";
import { SceneEditor } from "./scene/editor";
import { sceneCamera, sceneModel, sceneNavigation, type SceneModelChoice } from "./scene/sceneConfig";
import { StartPage } from "./scene/startPage";
import { el, guardTyping } from "./ui/dom";
import { Viewer } from "./viewer";

const backLink = () => el("p", {}, [el("a", { href: "./", textContent: "← Back to the scene list" })]);

/** scenes/<name>/scene.json -> scene doc + what to load. */
async function openScene(name: string): Promise<{ scene: SceneDoc; choice: SceneModelChoice; base: ViewerConfigFile }> {
  const { scene, errors } = validateScene(await fetchSceneJson(name));
  if (!scene) throw new Error(`scenes/${name}/scene.json is invalid: ${errors.join("; ")}`);
  if (scene.name !== name) throw new Error(`scenes/${name}/scene.json says name "${scene.name}"`);
  // A build recorded in scene.json but missing on disk (build/ is gitignored) falls back to the source.
  const built = !!scene.build && (await urlExists(`/scenes/${encodeURIComponent(name)}/build/${encodeURIComponent(scene.build.radFile)}`));
  const choice = sceneModel(scene, built);
  let camera = sceneCamera(scene);
  if (!camera && choice.mode === "built" && scene.build?.bounds) {
    // Paged models can't be auto-framed (no CPU-side splats yet): frame the build bounds.
    const { bboxMin: a, bboxMax: b } = scene.build.bounds;
    const c: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const r = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2;
    camera = { position: [c[0], c[1] + r * 0.3, c[2] + r * 1.2], target: c };
  }
  return {
    scene,
    choice,
    base: { models: [choice.model], camera, navigation: sceneNavigation(scene), controls: "orbit" },
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
    new StartPage(ui);
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
    viewer = new Viewer(app, config, device);
  } catch (err) {
    // Typically: WebGL2 unavailable.
    app.hidden = true;
    showMessage(ui, { title: "Renderer failed to start", lines: [(err as Error).message], error: true });
    return;
  }
  // Exposed for console debugging and future automation (e.g. scripted test routes).
  const w = window as unknown as Record<string, unknown>;
  w.viewer = viewer;

  new Overlay(ui, viewer);

  if (opened) {
    const editor = new SceneEditor(viewer, ui, opened.scene, opened.choice);
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
    title: opened?.choice.mode === "source" ? "Loading the source file (whole, not streamed)…" : "Loading…",
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
