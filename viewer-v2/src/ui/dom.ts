/**
 * Small DOM helpers shared by the editor UI: element factory, the
 * "is the user typing?" guard for shortcuts, toasts and modal dialogs.
 */
import "./ui.css";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  children: (Node | string | null | undefined | false)[] = [],
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/** True while focus is in a text field, select or contenteditable: shortcuts must not fire. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return true;
  if (t instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "range", "color"].includes(t.type);
  return false;
}

/**
 * Keys typed into a panel field never reach the camera controls or the global
 * shortcut handlers (window/document listeners): stop them at the UI root.
 * Escape blurs the field so the next key is a shortcut again.
 */
export function guardTyping(root: HTMLElement): void {
  const stop = (e: KeyboardEvent) => {
    if (!isTypingTarget(e.target)) return;
    if (e.type === "keydown" && e.key === "Escape") (e.target as HTMLElement).blur();
    // Ctrl/Cmd+S is handled by a capture listener on window before this runs.
    e.stopPropagation();
  };
  root.addEventListener("keydown", stop);
  root.addEventListener("keyup", stop);
}

export function kbd(key: string): HTMLElement {
  return el("kbd", { textContent: key });
}

// --- toasts ------------------------------------------------------------------

let toastHost: HTMLDivElement | null = null;

export type ToastKind = "info" | "ok" | "warn" | "error";

/** Stacked toast at the bottom centre. Errors stay until clicked (or 12 s). */
export function toast(message: string, kind: ToastKind = "info", ms?: number): HTMLDivElement {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el("div", { className: "toasts" });
    (document.getElementById("ui") ?? document.body).append(toastHost);
  }
  const t = el("div", { className: `toast-item ${kind}`, textContent: message, title: "Click to dismiss" });
  t.onclick = () => t.remove();
  toastHost.append(t);
  window.setTimeout(() => t.remove(), ms ?? (kind === "error" ? 12000 : kind === "warn" ? 6000 : 3000));
  return t;
}

// --- dialogs -------------------------------------------------------------------

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
  /** Disabled until this returns true (re-checked on every input event in the dialog). */
  enabled?: () => boolean;
}

/**
 * Modal dialog. Resolves with the clicked button's value, or `cancelValue`
 * on Escape / backdrop click. Enter clicks the primary button when enabled.
 */
export function dialog<T>(opts: {
  title: string;
  body?: (Node | string)[];
  buttons: DialogButton<T>[];
  cancelValue: T;
  focus?: HTMLElement;
}): Promise<T> {
  return new Promise((resolve) => {
    const host = document.getElementById("ui") ?? document.body;
    const btns = opts.buttons.map((b) => {
      const node = el("button", { textContent: b.label, className: b.primary ? "primary" : b.danger ? "danger" : "" });
      node.onclick = () => done(b.value);
      return { def: b, node };
    });
    const refresh = () => {
      for (const b of btns) b.node.disabled = b.def.enabled ? !b.def.enabled() : false;
    };
    const box = el("div", { className: "modal", role: "dialog" }, [
      el("h2", { textContent: opts.title }),
      el("div", { className: "modal-body" }, opts.body ?? []),
      el("div", { className: "modal-buttons" }, btns.map((b) => b.node)),
    ]);
    const backdrop = el("div", { className: "modal-backdrop" }, [box]);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(opts.cancelValue);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        const primary = btns.find((b) => b.def.primary);
        if (primary && !primary.node.disabled) {
          e.preventDefault();
          done(primary.def.value);
        }
      }
      e.stopPropagation(); // nothing typed in a dialog reaches the shortcuts
    };
    function done(v: T) {
      backdrop.remove();
      resolve(v);
    }
    backdrop.addEventListener("keydown", onKey);
    backdrop.addEventListener("keyup", (e) => e.stopPropagation());
    backdrop.addEventListener("input", refresh);
    backdrop.addEventListener("change", refresh);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) done(opts.cancelValue);
    });
    host.append(backdrop);
    refresh();
    (opts.focus ?? btns.find((b) => b.def.primary)?.node ?? btns[0]?.node)?.focus();
  });
}

export function confirmDialog(title: string, text: string, ok = "OK", danger = false): Promise<boolean> {
  return dialog({
    title,
    body: [el("p", { textContent: text })],
    buttons: [
      { label: "Cancel", value: false },
      { label: ok, value: true, primary: !danger, danger },
    ],
    cancelValue: false,
  });
}

export const fmtBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`;

export const fmtCount = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n);

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
