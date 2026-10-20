/**
 * Navigation entry point: creates the Navigation for a Viewer and plugs it
 * into the camera rig as the first-person ("walk") mode.
 */
import type { Viewer } from "../viewer";
import { Navigation } from "./navigation";

export { Navigation } from "./navigation";
export type { NavMode, NavPose, NavigationConfig } from "./navConfig";

export function attachNavigation(viewer: Viewer, uiRoot: HTMLElement): Navigation {
  const cam = viewer.config.camera;
  const nav = new Navigation({
    config: viewer.config.navigation,
    scene: viewer.scene,
    canvas: viewer.renderer.domElement,
    uiRoot,
    cameraStart: cam ? { position: cam.position, target: cam.target } : undefined,
  });
  viewer.rig.attachWalk(nav);
  // Console debugging / future automation: window.nav.moveTo({position:[x,y,z], yaw:90}, 1500)
  (window as unknown as { nav: Navigation }).nav = nav;
  return nav;
}
