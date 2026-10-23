/**
 * Top-bar sliders for how the view moves and how much detail it draws:
 *   Speed   camera movement multiplier (CameraRig.setSpeedScale: fly, walk, orbit pan + zoom)
 *   Detail  splat budget multiplier (Viewer.detail: Spark's lodSplatScale, or the GSL budget; shows the resulting budget)
 * Both are log-scaled and remembered per browser (viewPrefs.ts); the viewer
 * reads them at start-up, and a ?speed= / ?lodScale= URL parameter wins.
 * Spark's streaming page pool is sized from Detail when the page loads: a
 * Detail that needs a bigger pool shows "reload" until the page is reloaded.
 */
import { el, fmtCount } from "../ui/dom";
import type { Viewer } from "../viewer";
import { PREF_CAMERA_SPEED, PREF_DETAIL, poolPagesFor, writePref } from "../viewPrefs";

const STEPS = 1000;

/** A log-scale range input between `min` and `max` with a live readout. */
function logSlider(o: {
  label: string;
  title: string;
  min: number;
  max: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}): { root: HTMLElement; out: HTMLElement } {
  const toT = (v: number) => Math.round((Math.log(v / o.min) / Math.log(o.max / o.min)) * STEPS);
  const fromT = (t: number) => o.min * (o.max / o.min) ** (t / STEPS);
  const input = el("input", { type: "range", min: "0", max: String(STEPS), step: "1", value: String(toT(o.value)), title: o.title });
  const out = el("span", { className: "view-slider-value", textContent: o.format(o.value) });
  input.addEventListener("input", () => {
    const v = fromT(Number(input.value));
    out.textContent = o.format(v);
    o.onInput(v);
  });
  // Keys typed while the slider has focus must not move the camera.
  input.addEventListener("keydown", (e) => e.stopPropagation());
  return { root: el("label", { className: "view-slider", title: o.title }, [el("span", { textContent: o.label }), input, out]), out };
}

export function viewSliders(viewer: Viewer): HTMLElement {
  const fmtSpeed = (v: number) => `${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}×`;
  const speed = logSlider({
    label: "Speed",
    title: "Camera movement speed: fly / walk speed and orbit pan + zoom (turning is not affected). Remembered in this browser.",
    min: 0.02,
    max: 2,
    value: viewer.rig.speedScale,
    format: fmtSpeed,
    onInput: (v) => {
      viewer.rig.setSpeedScale(v);
      writePref(PREF_CAMERA_SPEED, v);
    },
  });
  const pool = viewer.poolPages;
  // Only Spark has a fixed page pool; GSL caches by memory budget instead.
  const needsReload = (v: number) => !!viewer.spark && !viewer.device.mobile && viewer.config.pages === undefined && poolPagesFor(v) > pool;
  const detailTitle = viewer.spark
    ? "Splat budget (Spark lodSplatScale): more splats give sharper close-ups but slower sorting and lower FPS. " +
      `Streaming pool: ${pool} pages (${fmtCount(pool * 65536)} splats), sized from Detail when the page loads. Remembered in this browser.`
    : "Splat budget (Gaussian Splat Lite, split between parts by screen coverage): more splats give sharper close-ups but lower FPS. Remembered in this browser.";
  const detail = logSlider({
    label: "Detail",
    title: detailTitle,
    min: 0.5,
    max: 8,
    value: viewer.detail,
    format: (v) => `${v.toFixed(1)}× · ${fmtCount(viewer.baseBudget * v)}${needsReload(v) ? " · reload" : ""}`,
    onInput: (v) => {
      viewer.detail = v;
      writePref(PREF_DETAIL, v);
      detail.out.title = needsReload(v) ? `Reload the page to grow the streaming pool to ${poolPagesFor(v)} pages; until then it stays at ${pool}.` : "";
    },
  });
  return el("span", { className: "view-sliders" }, [speed.root, detail.root]);
}
