/** Best-effort screen wake lock with visibility recovery and explicit release. */
interface ScreenWakeLockSentinel extends EventTarget {
  readonly released: boolean;
  release(): Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<ScreenWakeLockSentinel> };
}

let sentinel: ScreenWakeLockSentinel | undefined;
let wanted = false;
let acquiring: Promise<void> | undefined;

async function acquire(): Promise<void> {
  if (!wanted || sentinel || acquiring || typeof navigator === "undefined") return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  acquiring = (async () => {
    try {
      const next = await (navigator as unknown as WakeLockNavigator).wakeLock?.request("screen");
      if (!next) return;
      if (!wanted) {
        await next.release();
        return;
      }
      sentinel = next;
      next.addEventListener("release", () => {
        if (sentinel === next) sentinel = undefined;
      });
    } catch {
      // Permission, platform support and power policy are all best effort.
    }
  })().finally(() => {
    acquiring = undefined;
  });
  await acquiring;
}

export async function requestScreenWakeLock(): Promise<void> {
  wanted = true;
  await acquire();
}

export async function releaseScreenWakeLock(): Promise<void> {
  wanted = false;
  const current = sentinel;
  sentinel = undefined;
  if (current && !current.released) await current.release().catch(() => undefined);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wanted) void acquire();
  });
}
