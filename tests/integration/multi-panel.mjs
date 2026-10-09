// Two independent browsers stand in for two Chrome profiles, each capturing a
// (synthetic) tab via getDisplayMedia. Checks the single STOP
// (§64) across panels and that only one panel owns desktop notifications.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const token = process.env.ATTENTION_TOKEN;
if (!token) throw Error("Set ATTENTION_TOKEN for the running API");
const base = process.env.TEST_URL || "http://127.0.0.1:4317";
const post = (path, body = {}) =>
  fetch(`${base}/api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
await post("reset");
/** A browser = a profile: own storage, own tab picker, own meeting tab. */
async function profile(meetingTitle, card) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext();
  await context.grantPermissions(["notifications"], { origin: base });
  // Headless browsers cannot capture a real tab (no video source), so only the
  // OS/browser picker is replaced: a synthetic tab stream (tone + canvas video).
  // BrowserTabAudioSource, the 16 kHz worklet and track lifecycle run for real.
  await context.addInitScript((title) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      const canvas = document.createElement("canvas");
      canvas.title = title;
      const video = canvas.captureStream(1);
      return new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    };
  }, meetingTitle);
  const panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(base);
  await panel.getByLabel("Código de acesso", { exact: true }).fill(token);
  await panel.getByRole("button", { name: "Entrar", exact: true }).click();
  await panel.getByRole("button", { name: "Selecionar aba com áudio" }).nth(card).waitFor();
  return { browser, panel, card, errors };
}
const a = await profile("Reuniao A", 0);
const b = await profile("Reuniao B", 1);
for (const p of [a, b]) {
  await p.panel.getByRole("button", { name: "Selecionar aba com áudio" }).nth(p.card).click();
  await p.panel
    .getByRole("button", { name: "■ Parar aba" })
    .waitFor({ timeout: 10000 })
    .catch(async (e) => {
      const banner = await p.panel.locator(".error-banner").innerText().catch(() => "");
      throw Error(`capture did not start: ${banner || e.message}`);
    });
}
// Starting capture in B must not have stopped A (no transient running=false).
assert.equal(await a.panel.getByRole("button", { name: "■ Parar aba" }).count(), 1);
// Notifications: latest claim owns; the other panel shows it can take over.
await a.panel.getByRole("button", { name: "Ativar alertas desktop" }).click();
await a.panel.getByRole("button", { name: "✓ Alertas desktop" }).waitFor();
await b.panel.getByRole("button", { name: "Ativar alertas desktop" }).click();
await b.panel.getByRole("button", { name: "✓ Alertas desktop" }).waitFor();
await a.panel.getByRole("button", { name: "Alertas em outra janela · assumir" }).waitFor();
// One STOP in A ends the tab capture in B as well.
await a.panel.getByRole("button", { name: "■ Parar tudo" }).first().click();
await b.panel.getByText("Captura encerrada em outra janela.").waitFor({ timeout: 5000 });
assert.equal(await b.panel.getByRole("button", { name: "■ Parar aba" }).count(), 0);
// Owner leaves: the remaining panel with alerts enabled takes over.
await b.browser.close();
await a.panel.getByRole("button", { name: "✓ Alertas desktop" }).waitFor({ timeout: 5000 });
assert.deepEqual([...a.errors, ...b.errors], []);
await a.browser.close();
console.log(
  "Multi-panel integration passed: tab capture in two profiles (synthetic picker), start without cross-stop, single STOP across panels, one notification owner with hand-over.",
);
