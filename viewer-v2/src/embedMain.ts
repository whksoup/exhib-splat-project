/**
 * Boot path for `?embedded=1` (see src/embed.ts): no viewer chrome, walk
 * controls only, and a `window.splatWalk` API plus ready / failed messages for
 * the exhibition host.
 */
import { effectiveBudget, type ViewerConfig } from "./config";
import { resolveDevice } from "./device";
import {
  createSplatWalk,
  embeddedSpace,
  FAILED_MESSAGE,
  failureReason,
  hasWebGpu,
  READY_MESSAGE,
  tellParent,
  type FailureReason,
} from "./embed";
import { attachNavigation } from "./nav";
import { Viewer } from "./viewer";

export function embeddedFailure(reason: FailureReason, message: string): void {
  console.warn(`[embed] ${reason}: ${message}`);
  tellParent({ type: FAILED_MESSAGE, reason, message });
}

export async function runEmbedded(app: HTMLElement, ui: HTMLElement, config: ViewerConfig): Promise<void> {
  const space = embeddedSpace(window.location.search);
  document.body.classList.add("embedded", "no-topbar");
  config.overlay = false;
  config.controls = "walk";
  if (config.models.length === 0) {
    embeddedFailure("config", "The walk config names no model.");
    return;
  }
  // WebGPURenderer silently drops to its WebGL2 backend without WebGPU; the plan
  // falls back to the exhibition's own walk instead (?renderer=gsl-webgl opts in).
  if (config.renderer === "gsl" && !(await hasWebGpu())) {
    embeddedFailure("no-webgpu", "This browser does not offer WebGPU.");
    return;
  }

  const device = resolveDevice(config.device);
  config.budget = effectiveBudget(config, device);

  let viewer: Viewer;
  try {
    app.hidden = false;
    viewer = await Viewer.create(app, config, device);
  } catch (err) {
    app.hidden = true;
    embeddedFailure(failureReason(err), (err as Error).message);
    return;
  }
  const nav = attachNavigation(viewer, ui);
  await viewer.loadModels(false);
  if (viewer.models.length === 0) {
    viewer.dispose();
    nav.dispose();
    embeddedFailure("model", viewer.errors.join("; ") || "The model did not load.");
    return;
  }

  const api = createSplatWalk({
    space,
    target: {
      getPose: () => nav.getPose(),
      teleport: (pose) => nav.teleport(pose),
      respawn: () => nav.respawn(),
      getMode: () => nav.getMode(),
      setMode: (mode) => nav.setMode(mode),
      pointerLocked: () => document.pointerLockElement !== null,
    },
    diagnostics: () => ({
      renderer: viewer.rendererKind,
      device: device.profile.id,
      mobile: device.mobile,
      budget: viewer.budget,
      activeSplats: viewer.activeSplats,
      models: viewer.models.map((m) => m.spec.url),
      errors: [...viewer.errors],
      collision: nav.collisionStatus,
    }),
    dispose: () => {
      nav.dispose();
      viewer.dispose();
    },
  });
  (window as unknown as { splatWalk: typeof api }).splatWalk = api;
  tellParent({ type: READY_MESSAGE });
}
