import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const token = process.env.ATTENTION_TOKEN;
if (!token) throw Error("Set ATTENTION_TOKEN for the running API");
const base = process.env.TEST_URL || "http://127.0.0.1:4317";
for (let i = 0; i < 50; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? {
        executablePath: process.env.CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(base);
await page.getByLabel("Código de acesso", { exact: true }).fill(token);
await page.getByRole("button", { name: "Entrar", exact: true }).click();
await page
  .getByRole("button", { name: "Iniciar demo", exact: false })
  .waitFor();
await page.getByRole("button", { name: "Iniciar demo", exact: false }).click();
await page.waitForFunction(
  () =>
    [...document.querySelectorAll(".score strong")].some(
      (el) => el.textContent === "97",
    ),
  {},
  { timeout: 20000 },
);
assert.deepEqual(await page.locator(".score strong").allTextContents(), [
  "18",
  "97",
]);
assert.equal(await page.locator(".event").count(), 1);
assert.ok(
  (await page.locator(".recommendation").innerText()).includes(
    "Mude sua atenção",
  ),
);
assert.equal(await page.locator(".recommendation.urgent").count(), 1);
assert.equal(await page.locator("header .badge").innerText(), "1");
assert.equal(await page.locator(".event.urgent-event").count(), 1);
await mkdir("docs/screenshots", { recursive: true });
await page.screenshot({
  path: "docs/screenshots/dashboard.png",
  fullPage: true,
});
await page
  .getByRole("button", { name: "Catch me up", exact: true })
  .nth(1)
  .click();
await page.getByRole("dialog").waitFor();
assert.ok((await page.getByRole("dialog").innerText()).includes("endpoint"));
await page.getByRole("button", { name: "Fechar", exact: true }).click();
await page
  .locator(".recommendation")
  .getByRole("button", { name: "Ver contexto", exact: true })
  .click();
assert.ok((await page.getByRole("dialog").innerText()).includes("BLOCKER"));
await page.getByRole("button", { name: "Fechar", exact: true }).click();
await page.locator("header .badge").waitFor({ state: "detached" });
await page
  .locator(".event")
  .getByRole("button", { name: "Ver contexto", exact: true })
  .click();
assert.ok((await page.getByRole("dialog").innerText()).includes("BLOCKER"));
await page.getByRole("button", { name: "Fechar", exact: true }).click();
const sound = page.getByRole("button", { name: "Som em urgentes", exact: true });
await sound.click();
await page
  .getByRole("button", { name: "✓ Som suave em urgentes", exact: true })
  .click();
await sound.waitFor();
await page.getByRole("button", { name: "Gerar resposta", exact: true }).click();
await page
  .getByLabel("Resposta Curta")
  .fill("Recebi. Vou conferir antes de confirmar.");
assert.equal(
  await page.getByLabel("Resposta Curta").inputValue(),
  "Recebi. Vou conferir antes de confirmar.",
);
await page.getByRole("button", { name: "Fechar", exact: true }).click();
await page.getByLabel("Avaliar alerta").selectOption("useful");
await page.getByRole("button", { name: "Respondido", exact: true }).click();
await page.waitForFunction(
  () => document.querySelectorAll(".score strong")[1]?.textContent === "18",
);
// Low-confidence request in the other meeting: 🟡 possible, never a switch.
const post = (path, body) =>
  fetch(`${base}/api/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
await post("capture/start", {});
const t = Date.now();
await post("transcript", {
  id: "ui-possible",
  meetingId: "backend",
  speakerId: "Voz não identificada",
  text: "Nataniel, consegue verificar o endpoint agora?",
  startTime: t - 1000,
  endTime: t,
  confidence: 0.61,
});
await page.locator(".recommendation.possible").waitFor();
assert.ok(
  (await page.locator(".recommendation").innerText()).includes("61%"),
);
await post("stop", {});
await page.getByRole("button", { name: "Configurar", exact: true }).click();
const config = JSON.parse(
  await page.getByLabel("Configuração do perfil").inputValue(),
);
config.profile.name = "Teste";
await page.getByLabel("Configuração do perfil").fill(JSON.stringify(config));
await page.getByRole("button", { name: "Salvar", exact: true }).click();
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page.getByRole("button", { name: "Mini modo", exact: true }).click();
assert.equal(await page.locator(".app.compact").count(), 1);
await page.getByRole("button", { name: "Expandir", exact: true }).click();
await page.setViewportSize({ width: 390, height: 844 });
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.screenshot({ path: "docs/screenshots/mobile.png", fullPage: true });
assert.deepEqual(errors, []);
await page.getByRole("button", { name: "Parar tudo", exact: false }).click();
await browser.close();
console.log(
  "UI integration passed: login, demo 18/97, recommendation, dedup, catch-up, context, editable responses, feedback, resolution, settings, mini mode, mobile layout, no page errors.",
);
