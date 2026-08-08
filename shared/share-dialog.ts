// The share dialog the home page and the sender both carry: a QR of the
// receiver URL, the link itself copyable, and the OS share sheet where one
// exists. Hosted pages derive the URL from their own navigation so project
// subpaths and custom domains share themselves. A standalone sender has no
// receiver link in its navigation and retains the build-time fallback.

import QRCode from "qrcode";
import { closeOnBackdropClick } from "./dialog";

/** Wire the page's share dialog; returns the opener. */
export function wireShareDialog(): () => void {
  const dialog = document.getElementById("share-dialog") as HTMLDialogElement;
  const canvas = document.getElementById("share-qr") as HTMLCanvasElement;
  const urlInput = document.getElementById("share-url") as HTMLInputElement;
  const copyBtn = document.getElementById("share-copy") as HTMLButtonElement;
  const nativeBtn = document.getElementById("share-native") as HTMLButtonElement;

  if (location.protocol === "http:" || location.protocol === "https:") {
    if (urlInput.dataset.shareTarget === "app") {
      urlInput.value = new URL("./", location.href).href;
    } else if (urlInput.dataset.shareTarget === "receiver") {
      const receiveLink = document.querySelector<HTMLAnchorElement>('a[href$="receive/"]');
      const relative = receiveLink?.getAttribute("href");
      if (relative) urlInput.value = new URL(relative, location.href).href;
    }
  }

  document.getElementById("share-close")!.addEventListener("click", () => dialog.close());
  closeOnBackdropClick(dialog);

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(urlInput.value);
      copyBtn.textContent = "Copied";
    } catch {
      // Leave the text selected so a manual copy is one keystroke away.
      urlInput.select();
      copyBtn.textContent = "Copy failed";
    }
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1500);
  });

  nativeBtn.addEventListener("click", () => {
    void navigator
      .share({ title: dialog.dataset.shareTitle ?? document.title, url: urlInput.value })
      .catch(() => undefined); // cancelling the sheet is not an error
  });

  // Drawn on first open; the resolved receiver URL stays fixed for this page.
  let qrDrawn = false;
  return () => {
    if (!qrDrawn) {
      qrDrawn = true;
      void QRCode.toCanvas(canvas, urlInput.value, { margin: 2, width: 220 });
    }
    nativeBtn.hidden = typeof navigator.share !== "function";
    dialog.showModal();
  };
}
