/**
 * Build panel: starts POST /__build, follows /__build/events (SSE) with a
 * progress bar and a scrolling log, and cancels. It also notices builds it did
 * not start: from another tab (same SSE stream) or from build-scene.bat
 * (`external` in /__build/status, polled).
 */
import { api, type BuildStatus } from "./api";
import { el } from "../ui/dom";

export type BuildPhase = "idle" | "running" | "ok" | "failed";

export interface BuildEvents {
  /** A build of `name` finished (any source: this tab, another tab, the command line). */
  onFinished(name: string, ok: boolean, error: string | null): void;
  /** Running state changed (to refresh the top bar). */
  onState(): void;
}

const MAX_LINES = 3000;

export class BuildPanel {
  readonly panel: HTMLDivElement;
  phase: BuildPhase = "idle";
  pct = 0;
  /** Name of the scene being built (by anyone), if a build is running. */
  runningName: string | null = null;
  /** The running build was started outside the dev server (build-scene.bat). */
  external = false;
  lastError: string | null = null;

  private readonly bar: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly log: HTMLPreElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly title: HTMLElement;
  private es: EventSource | null = null;
  /** Build id whose events are just a replay of an old, already finished build. */
  private ignoreId = -1;
  private currentId = -1;
  private handledDoneId = -1;
  private lineCount = 0;
  private externalName: string | null = null;
  private pollTimer = 0;

  constructor(
    private readonly sceneName: string,
    private readonly events: BuildEvents,
  ) {
    this.bar = el("div");
    this.stage = el("div", { className: "panel-note" });
    this.log = el("pre", { className: "build-log" });
    this.title = el("strong", { textContent: "Build" });
    this.cancelButton = el("button", { textContent: "Cancel build", className: "danger", hidden: true, onclick: () => void this.cancel() });
    this.panel = el("div", { className: "plan-panel build-panel", hidden: true }, [
      el("div", { className: "plan-head" }, [this.title, el("button", { textContent: "Close", title: "Hide (B); the build keeps running", onclick: () => this.show(false) })]),
      el("div", { className: "build-progress" }, [this.bar]),
      this.stage,
      this.log,
      el("div", { className: "plan-row" }, [this.cancelButton]),
    ]);
    this.title.addEventListener("click", () => this.panel.classList.toggle("collapsed"));
  }

  get visible(): boolean {
    return !this.panel.hidden;
  }

  show(on = true): void {
    this.panel.hidden = !on;
    if (on) {
      this.panel.classList.remove("collapsed");
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  /** Connect to the server: current status first (to tell old builds from live ones), then the event stream. */
  async connect(): Promise<void> {
    try {
      const st = await api.buildStatus();
      this.ignoreId = st.running ? -1 : st.id;
      this.applyStatus(st, true);
    } catch {
      /* no dev server: Build will report it */
    }
    this.es = new EventSource("/__build/events");
    this.es.addEventListener("reset", (e) => this.onReset(JSON.parse((e as MessageEvent).data) as { id: number; name: string | null }));
    this.es.addEventListener("log", (e) => this.onLog(JSON.parse((e as MessageEvent).data) as string));
    this.es.addEventListener("progress", (e) => this.onProgress(JSON.parse((e as MessageEvent).data) as NonNullable<BuildStatus["progress"]>));
    this.es.addEventListener("done", (e) => this.onDone(JSON.parse((e as MessageEvent).data) as { id: number; name: string; status: string; error: string | null }));
    // Command-line builds don't go through the dev server: poll for the lock.
    this.pollTimer = window.setInterval(() => void this.poll(), 4000);
  }

  dispose(): void {
    this.es?.close();
    window.clearInterval(this.pollTimer);
  }

  /** Start a build of this scene (caller checks for unsaved changes). */
  async start(): Promise<void> {
    if (this.phase === "running") {
      this.show();
      throw new Error(this.runningName === this.sceneName ? "This scene is already building." : `A build of "${this.runningName}" is running; one build at a time.`);
    }
    this.resetView(`Starting build of ${this.sceneName}…`);
    this.show();
    const st = await api.build(this.sceneName); // throws on 409 etc.
    this.ignoreId = -1;
    this.currentId = st.id;
    this.setRunning(this.sceneName, false);
  }

  async cancel(): Promise<void> {
    if (this.external) {
      this.appendLine("This build was started from the command line (build-scene.bat): stop it there (Ctrl+C).", true);
      return;
    }
    this.cancelButton.disabled = true;
    try {
      await api.cancelBuild();
    } catch (err) {
      this.appendLine(`Cancel failed: ${(err as Error).message}`, true);
    } finally {
      this.cancelButton.disabled = false;
    }
  }

  // --- events ---------------------------------------------------------------

  /** True while the stream is (re)playing a build that is already finished and handled. */
  private get stale(): boolean {
    return this.currentId === this.ignoreId || this.currentId <= this.handledDoneId;
  }

  private onReset(d: { id: number; name: string | null }): void {
    if (d.id === this.currentId) {
      // (Re)connected to the build we already follow: the server replays its whole log next.
      if (this.phase === "running" && !this.external) {
        this.log.replaceChildren();
        this.lineCount = 0;
      }
      return;
    }
    this.currentId = d.id;
    if (this.stale) return; // replay of an old build
    this.resetView(d.name === this.sceneName ? `Building ${d.name}` : `Building another scene: ${d.name}`);
    this.setRunning(d.name, false);
    if (d.name === this.sceneName) this.show();
  }

  private onLog(line: string): void {
    if (this.stale) return;
    this.appendLine(line, /^(error|fatal)\b|failed|cancel/i.test(line));
  }

  private onProgress(p: NonNullable<BuildStatus["progress"]>): void {
    if (this.stale) return;
    this.pct = Math.max(0, Math.min(100, p.pct));
    this.bar.style.width = `${this.pct}%`;
    this.stage.textContent = `${p.stage}${p.message ? `: ${p.message}` : ""} (${Math.round(this.pct)}%)`;
    this.events.onState();
  }

  private onDone(d: { id: number; name: string; status: string; error: string | null }): void {
    if (d.id === this.ignoreId || d.id <= this.handledDoneId) return;
    this.handledDoneId = d.id;
    this.finish(d.name, d.status === "ok", d.error);
  }

  private finish(name: string, ok: boolean, error: string | null): void {
    this.runningName = null;
    this.external = false;
    this.cancelButton.hidden = true;
    this.phase = ok ? "ok" : "failed";
    this.lastError = ok ? null : (error ?? "build failed");
    this.panel.classList.toggle("ok", ok);
    this.panel.classList.toggle("failed", !ok);
    if (ok) {
      this.pct = 100;
      this.bar.style.width = "100%";
      this.stage.textContent = `Build of ${name} finished.`;
    } else {
      this.stage.textContent = `Build of ${name} failed: ${this.lastError}`;
      this.stage.classList.add("bad");
      if (name === this.sceneName) this.show();
    }
    this.events.onState();
    this.events.onFinished(name, ok, this.lastError);
  }

  private async poll(): Promise<void> {
    if (document.visibilityState !== "visible" && this.phase !== "running") return;
    try {
      this.applyStatus(await api.buildStatus(), false);
    } catch {
      /* server restarting */
    }
  }

  private applyStatus(st: BuildStatus, initial: boolean): void {
    if (st.external) {
      if (this.externalName !== st.external.scene) {
        this.externalName = st.external.scene;
        this.resetView(`Building ${st.external.scene} from the command line (pid ${st.external.pid}), started ${new Date(st.external.startedAt).toLocaleTimeString()}.`);
        this.appendLine("Progress and log are shown in that terminal (build-scene.bat).", false);
        this.setRunning(st.external.scene, true);
        this.stage.textContent = "Running from the command line…";
      }
      return;
    }
    if (this.externalName) {
      // The command-line build ended; the editor re-reads scene.json to learn the result.
      const name = this.externalName;
      this.externalName = null;
      this.runningName = null;
      this.external = false;
      this.phase = "idle";
      this.events.onState();
      this.events.onFinished(name, true, null);
      return;
    }
    if (initial && st.running) {
      this.currentId = st.id;
      this.resetView(st.name === this.sceneName ? `Building ${st.name}` : `Building another scene: ${st.name}`);
      // The SSE replay delivers the log lines; progress comes with it too.
      this.setRunning(st.name, false);
      if (st.name === this.sceneName) this.show();
    }
  }

  // --- view -------------------------------------------------------------------

  private setRunning(name: string | null, external: boolean): void {
    this.phase = "running";
    this.runningName = name;
    this.external = external;
    this.cancelButton.hidden = false;
    this.cancelButton.textContent = external ? "Cancel (command line)…" : "Cancel build";
    this.events.onState();
  }

  private resetView(title: string): void {
    this.panel.classList.remove("ok", "failed");
    this.stage.classList.remove("bad");
    this.pct = 0;
    this.bar.style.width = "0%";
    this.stage.textContent = title;
    this.log.replaceChildren();
    this.lineCount = 0;
  }

  private appendLine(line: string, bad: boolean): void {
    const stick = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 24;
    const node = el("div", { textContent: line, className: bad ? "err" : "" });
    this.log.append(node);
    if (++this.lineCount > MAX_LINES) this.log.firstChild?.remove();
    if (stick) this.log.scrollTop = this.log.scrollHeight;
  }
}
