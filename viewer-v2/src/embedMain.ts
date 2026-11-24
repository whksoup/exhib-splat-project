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
  serveOverMessages,
  tellParent,
  type FailureReason,
} from "./embed";
import { ExhibitLayer } from "./exhibit/layer";
import { parseWorks } from "./exhibit/targeting";
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
  // The collision GLB loads beside the models; wait for it, since loading it respawns the player.
  await Promise.all([viewer.loadModels(false), nav.ready]);
  if (viewer.models.length === 0) {
    viewer.dispose();
    nav.dispose();
    embeddedFailure("model", viewer.errors.join("; ") || "The model did not load.");
    return;
  }

  let api: ReturnType<typeof createSplatWalk> | null = null;
  const mpu = viewer.config.navigation.metresPerUnit ?? 1;
  // ?exhibitDebug=1 (the exhibition's ?walkDebug=1): fly freely through everything, drag to look, edit colliders.
  const debug = new URLSearchParams(window.location.search).get("exhibitDebug") === "1";
  const setFlying = (on: boolean) => {
    nav.player.cfg.allowFly = nav.player.cfg.allowFly || on;
    nav.player.noclip = on;
    nav.setMode(on ? "fly" : "walk");
  };
  const exhibit = new ExhibitLayer({
    ui,
    canvas: viewer.renderer.domElement,
    camera: viewer.camera,
    setSuspended: (s) => viewer.rig.setSuspended(s),
    allowPointerLock: (a) => nav.setPointerLockAllowed(a),
    metresPerUnit: viewer.config.navigation.metresPerUnit,
    onOpenWork: (id) => api?.openWork(id),
    onReset: () => api?.reset(),
    onChange: () => api?.publish(),
    onEditWork: (edit) => api?.editWork(edit),
    debug,
    setFlying,
    scene: viewer.scene,
    eyeHeight: Math.round(nav.config.eyeHeight * mpu * 100) / 100,
    setEyeHeight: (metres) => {
      const cfg = nav.player.cfg;
      cfg.eyeHeight = metres / mpu;
      // The capsule must stay taller than the eye.
      cfg.height = Math.max(cfg.height, cfg.eyeHeight + 0.1 / mpu);
    },
  });
  viewer.onFrame.push(({ now }) => exhibit.update(now));
  const layer = {
    setWorks: (works: unknown) => exhibit.setWorks(parseWorks(works)),
    showGuide: () => exhibit.showGuide(),
    setPreview: (id: string | null) => exhibit.setPreview(id),
    pause: (focus?: boolean) => exhibit.pause(focus),
    resume: () => exhibit.resume(),
    escape: () => exhibit.escape(),
    setEditStatus: (text: string) => exhibit.setEditStatus(text),
    get inView() {
      return exhibit.inView;
    },
    get navigation() {
      return exhibit.navigation;
    },
  };

  api = createSplatWalk({
    space,
    layer,
    target: {
      getPose: () => nav.getPose(),
      teleport: (pose) => nav.teleport(pose),
      respawn: () => nav.respawn(),
      getMode: () => nav.getMode(),
      // The debug view always flies; the visitor's walk never does (a debug snapshot can come back in history).
      setMode: (mode) => (debug ? (setFlying(true), nav.getMode()) : nav.setMode(mode === "fly" ? "walk" : mode)),
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
      exhibit: exhibit.diagnostics,
    }),
    dispose: () => {
      stopServing();
      exhibit.dispose();
      nav.dispose();
      viewer.dispose();
    },
  });
  const walk = api;
  const stopServing = window.parent !== window ? serveOverMessages(walk, window.parent) : () => {};
  (window as unknown as { splatWalk: typeof walk }).splatWalk = walk;
  tellParent({ type: READY_MESSAGE });
}
