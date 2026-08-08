# Privacy

**Nothing is transmitted anywhere except as light.** There is no account, no pairing, no analytics, and no network path between the devices — the site works with the network off after the first visit.

**The channel is not confidential.** Whatever is on the transmitting screen is readable by *any* camera pointed at it. CVTP gives you *no network path*, not encryption. Don't stream secrets in a room you don't trust.

**Integrity is checked.** Every received file is verified against its SHA-256 before being offered; a corrupted stream fails loudly rather than handing over damaged bytes.

## What persists on the receiving device

- **Text snippets: nothing.** Shown with a Copy button, gone when the tab closes.
- **Files you save** go wherever your browser puts downloads.
- **Received media** (video/audio, so the in-page player can seek) is staged in the browser's Cache API and would otherwise linger until the next transfer overwrites it. The **Clear received media** action next to *Capture another transfer* deletes it on the spot — use it before handing the phone to someone.
- **Experiment summaries and preferences** may be stored in IndexedDB. They
  contain counters, timings, selected settings and optional device labels, but
  never file bytes, snippets, optical frames or fountain equations. They can be
  exported as JSON and cleared from the diagnostics panel.
- The service worker's offline **precache** holds only the app itself. The
  separate `received-media` runtime cache is the temporary media exception
  described above and can be cleared from the receiver UI.
