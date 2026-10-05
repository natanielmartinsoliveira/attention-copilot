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
