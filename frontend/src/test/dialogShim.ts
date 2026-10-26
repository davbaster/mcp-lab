/**
 * jsdom has an empty `HTMLDialogElement`: no `showModal()`, `close()`, `cancel` event, or Escape.
 * This gives tests just enough of the native behaviour to open and close a dialog:
 *
 *   showModal()  sets `open`
 *   close()      removes `open` at once and fires `close` in a later task, as browsers queue it
 *   Escape       fires a cancelable `cancel`, then closes unless it was prevented
 *
 * It does not make the page behind the dialog inert and does not trap Tab: that is the browser's
 * job, and is checked by hand in a real browser (see the PR of #25). `renderApp` installs it.
 */

const modals: HTMLDialogElement[] = [];
let listening = false;

function closeDialog(dialog: HTMLDialogElement): void {
  if (!dialog.hasAttribute("open")) return;
  dialog.removeAttribute("open");
  const index = modals.indexOf(dialog);
  if (index !== -1) modals.splice(index, 1);
  // A browser queues the `close` event as a task, so code that reacts to it runs after whatever
  // follows the `close()` call (for example a focus move by the code that called it).
  setTimeout(() => dialog.dispatchEvent(new Event("close")), 0);
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const dialog = modals.at(-1);
  if (!dialog) return;
  const cancel = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  if (!cancel.defaultPrevented) closeDialog(dialog);
}

export function installDialogShim(): void {
  const proto = window.HTMLDialogElement.prototype;
  if (typeof proto.showModal === "function") return;

  Object.defineProperty(proto, "open", {
    configurable: true,
    get(this: HTMLDialogElement) {
      return this.hasAttribute("open");
    },
    set(this: HTMLDialogElement, value: boolean) {
      this.toggleAttribute("open", Boolean(value));
    },
  });
  proto.showModal = function showModal(this: HTMLDialogElement) {
    if (this.hasAttribute("open")) throw new DOMException("The dialog is already open.", "InvalidStateError");
    this.setAttribute("open", "");
    modals.push(this);
  };
  proto.close = function close(this: HTMLDialogElement) {
    closeDialog(this);
  };
  if (!listening) {
    listening = true;
    document.addEventListener("keydown", onKeyDown);
  }
}
