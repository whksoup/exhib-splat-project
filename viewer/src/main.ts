import "./style.css";
import { loadConfig } from "./config";
import { resolveDevice } from "./device";
import { appendModelPicker, Overlay, showMessage } from "./overlay";
import { Viewer } from "./viewer";

async function main(): Promise<void> {
  const app = document.getElementById("app");
  const ui = document.getElementById("ui");
  if (!app || !ui) throw new Error("index.html is missing #app / #ui");

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    showMessage(ui, { title: "Config failed to load", lines: [(err as Error).message], error: true });
    return;
  }

  const device = resolveDevice(config.device);

  let viewer: Viewer;
  try {
    viewer = new Viewer(app, config, device);
  } catch (err) {
    // Typically: WebGL2 unavailable.
    showMessage(ui, { title: "Renderer failed to start", lines: [(err as Error).message], error: true });
    return;
  }
  // Exposed for console debugging and future automation (e.g. scripted test routes).
  (window as unknown as { viewer: Viewer }).viewer = viewer;

  new Overlay(ui, viewer);

  if (config.models.length === 0) {
    const card = showMessage(ui, {
      title: "No model specified",
      lines: [
        "Add ?model=<url> to the address, e.g.",
        "?model=/models/<name>/<version>/<stem>-lod.rad   (streamed, paged LoD)",
        "?model=/source/<file>.ply  (or .spz / .sog, loaded whole)",
        "See viewer/README.md for all parameters.",
      ],
    });
    void appendModelPicker(card);
    return;
  }

  const loading = showMessage(ui, { title: "Loading…", lines: config.models.map((m) => m.url) });
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
    if (allFailed) void appendModelPicker(card);
    else window.setTimeout(() => card.remove(), 8000);
  }
}

void main();
