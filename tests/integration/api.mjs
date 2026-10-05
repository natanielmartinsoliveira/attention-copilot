import assert from "node:assert/strict";
import { io } from "socket.io-client";
const base = process.env.TEST_URL || "http://127.0.0.1:4317";
const token = process.env.ATTENTION_TOKEN;
if (!token) throw Error("Set ATTENTION_TOKEN for the running API");
const request = async (
  path,
  body,
  method = body === undefined ? "GET" : "POST",
) => {
  const r = await fetch(base + "/api/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
};
for (let i = 0; i < 50; i++) {
  try {
    await fetch(base + "/api/state");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
assert.equal((await fetch(base + "/api/state")).status, 401);
assert.equal(
  (
    await fetch(base + "/api/state", {
      headers: {
        Authorization: "Bearer " + token,
        Origin: "https://untrusted.example",
      },
    })
  ).status,
  403,
);
assert.equal((await request("profile", { name: "" })).status, 400);
assert.equal(
  (await request("settings", { minAttentionDelta: -1 })).status,
  400,
);
const socket = io(base, { auth: { token }, transports: ["websocket"] });
let updates = 0;
socket.on("state", () => updates++);
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", reject);
  setTimeout(() => reject(Error("Socket timeout")), 5000).unref();
});
await request("demo/start", {});
const end = Date.now() + 18000;
let state;
while (Date.now() < end) {
  state = (await request("state")).data;
  if (state.meetings.find((m) => m.id === "backend").attentionScore === 97)
    break;
  await new Promise((r) => setTimeout(r, 200));
}
assert.equal(
  state.meetings.find((m) => m.id === "frontend").attentionScore,
  18,
);
assert.equal(state.meetings.find((m) => m.id === "backend").attentionScore, 97);
assert.equal(state.recommendation.switchAttention, true);
assert.ok(updates >= 7);
const event = state.meetings.find((m) => m.id === "backend").events[0];
assert.ok(
  (await request(`events/${event.id}/context`)).data.segments.length >= 4,
);
const caught = await request("meetings/backend/catch-up", { ultra: true });
assert.ok(caught.data.summary.length >= 1);
assert.equal(caught.data.pending.length, 1);
assert.equal(
  (await request(`events/${event.id}/response`, {})).data.safe,
  true,
);
await request(`events/${event.id}/feedback`, { rating: "useful" });
await request(`events/${event.id}/status`, { status: "RESPONDED" });
assert.equal(
  (await request("state")).data.meetings.find((m) => m.id === "backend")
    .attentionScore,
  18,
);
assert.equal(
  (await request(`events/${event.id}/status`, { status: "SEEN" })).status,
  400,
);
await request("capture/start", {});
const id = (await request("meetings", { title: "Third", platform: "Demo" }))
  .data.id;
const now = Date.now();
const transcript = {
  id: "integration-" + now,
  meetingId: id,
  speakerId: "Maria",
  text: "Nataniel, consegue verificar o endpoint?",
  startTime: now - 500,
  endTime: now,
  confidence: 1,
};
assert.equal((await request("transcript", transcript)).status, 200);
await request("transcript", transcript);
assert.equal(
  (await request("state")).data.meetings.find((m) => m.id === id).transcript
    .length,
  1,
);
await request("stop", {});
assert.equal(
  (await request("transcript", { ...transcript, id: "late" })).status,
  400,
);
await request("meetings/" + id, undefined, "DELETE");
assert.equal((await request("state")).data.meetings.length, 2);
socket.close();
console.log(
  "API integration passed: auth, origin, validation, WebSocket, demo 18/97, context, catch-up, response, feedback, lifecycle, multi-meeting, idempotency, STOP, deletion.",
);
