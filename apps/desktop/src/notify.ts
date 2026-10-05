export async function enableNotifications() {
  if ("__TAURI_INTERNALS__" in window) {
    const p = await import("@tauri-apps/plugin-notification");
    if (!(await p.isPermissionGranted()))
      return (await p.requestPermission()) === "granted";
    return true;
  }
  return (
    "Notification" in window &&
    (await Notification.requestPermission()) === "granted"
  );
}
export async function notify(title: string, body: string) {
  if ("__TAURI_INTERNALS__" in window) {
    const p = await import("@tauri-apps/plugin-notification");
    if (await p.isPermissionGranted()) p.sendNotification({ title, body });
  } else if ("Notification" in window && Notification.permission === "granted")
    new Notification(title, { body, silent: true });
}
/** Short, quiet sine chime for URGENT alerts (opt-in); never a siren. */
export async function playSoftTone() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator(),
    gain = ctx.createGain(),
    t = ctx.currentTime;
  osc.frequency.value = 660;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.06, t + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.4);
  osc.onended = () => void ctx.close();
}
export async function miniWindow(compact: boolean) {
  if ("__TAURI_INTERNALS__" in window) {
    const { getCurrentWindow, LogicalSize } = await import(
      "@tauri-apps/api/window"
    );
    const w = getCurrentWindow();
    await w.setAlwaysOnTop(compact);
    await w.setSize(new LogicalSize(compact ? 430 : 1280, compact ? 260 : 840));
  }
}
