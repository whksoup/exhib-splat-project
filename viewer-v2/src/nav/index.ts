/**
 * Navigation entry point: creates the Navigation for a Viewer and plugs it
 * into the camera rig as the first-person ("walk") mode.
 */
import type { Viewer } from "../viewer";
import { Navigation } from "./navigation";

export { Navigation } from "./navigation";
export type { NavMode, NavPose, NavigationConfig } from "./navConfig";

/** Create the walk controller from viewer.config (navigation + camera). Call again to rebuild after edits. */
export function attachNavigation(viewer: Viewer, uiRoot: HTMLElement, previous?: Navigation): Navigation {
  const cam = viewer.config.camera;
  const debug = previous?.debugVisible;
  if (previous) {
    previous.setActive(false);
    previous.dispose();
  }
  const nav = new Navigation({
    config: viewer.config.navigation,
    scene: viewer.scene,
    canvas: viewer.renderer.domElement,
    uiRoot,
    cameraStart: cam ? { position: cam.position, target: cam.target } : undefined,
  });
  if (debug !== undefined) nav.debugVisible = debug;
  viewer.rig.attachWalk(nav);
  // Console debugging / future automation: window.nav.moveTo({position:[x,y,z], yaw:90}, 1500)
  (window as unknown as { nav: Navigation }).nav = nav;
  return nav;
}
