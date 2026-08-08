# Quick start

1. Open this application on both devices.
2. On both pages, select the same carrier: **QR (legacy)** for proven Decimen
   interoperability, or **COLOR_4 robust** for the colour MVP.
3. On the sending device (a laptop is ideal): choose **Transmit**, then pick a file. The optical
   stream starts immediately. Turn the screen brightness all the way up.
4. On the receiving device (a phone): choose **Capture**, tap **Start camera**, point
   it at the code. Fill the camera view with it and prop the phone against
   something.
5. When the bar completes, the file appears with a preview and a **Save** link
   — after its SHA-256 check passes.

To send text instead of a file, flip the sender to **Text snippet** and paste. The receiver is the same page either way.

Nothing decoding? See [Troubleshooting](troubleshooting.md).

Changing carrier, colour profile or palette starts a fresh transfer. Reloading
either page cancels it; the partial file is intentionally not persisted.

## Running it yourself

Requires Node.js 22.

```powershell
npm ci
npm run dev     # HTTPS dev server — accept the self-signed cert warning once
```

Open `https://localhost:5173/send/` on the sender and the printed `Network` URL (`https://<lan-ip>:5173/receive/`) on the phone. The dev server is https-only because browsers remove the camera API on insecure origins — see [Install & offline](install-and-offline.md) for the details and all the other ways to run it.
