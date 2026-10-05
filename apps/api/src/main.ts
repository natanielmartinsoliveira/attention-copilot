import "reflect-metadata";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { Module, Controller, All, Req, Res } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { Server } from "socket.io";
import { State } from "./state.js";
import { Infrastructure } from "./infrastructure.js";
import {
  EVENT_TYPES,
  type EventStatus,
  type UserProfile,
  type TranscriptSegment,
} from "../../../packages/core/src/types.js";
const state = new State(),
  token = process.env.ATTENTION_TOKEN || randomBytes(24).toString("hex");
const port = Number(process.env.PORT || 4317);
const allowed = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  // The UI is served by this process, so its origin follows PORT.
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
]);
const auth = (value: unknown) =>
  typeof value === "string" &&
  Buffer.byteLength(value) === Buffer.byteLength(token) &&
  timingSafeEqual(Buffer.from(value), Buffer.from(token));
let infra: Infrastructure | undefined;
const str = (x: unknown, max = 200) => {
  if (typeof x !== "string" || !x.trim() || x.length > max)
    throw Error("Texto inválido");
  return x.trim();
};
const num = (x: unknown, min: number, max: number) => {
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max)
    throw Error("Número inválido");
  return x;
};
const bool = (x: unknown, fallback: boolean) => {
  if (x === undefined) return fallback;
  if (typeof x !== "boolean") throw Error("Valor inválido");
  return x;
};
const strings = (x: unknown) => {
  if (!Array.isArray(x) || x.length > 100) throw Error("Lista inválida");
  return x.map((v) => str(v, 200));
};
function profile(b: Record<string, unknown>): UserProfile {
  const ranked = (x: unknown) => {
    if (!Array.isArray(x) || x.length > 100) throw Error("Lista inválida");
    return x.map((p: unknown) => {
      if (typeof p !== "object" || p === null) throw Error("Lista inválida");
      const item = p as Record<string, unknown>;
      return { name: str(item.name), importance: num(item.importance, 0, 100) };
    });
  };
  return {
    name: str(b.name),
    fullName: str(b.fullName),
    aliases: strings(b.aliases),
    role: str(b.role),
    teams: strings(b.teams),
    projects: ranked(b.projects),
    expertise: strings(b.expertise),
    people: ranked(b.people),
  };
}
function segment(b: Record<string, unknown>): TranscriptSegment {
  const startTime = num(b.startTime, Date.now() - 86400000, Date.now() + 30000),
    endTime = num(b.endTime, startTime, Date.now() + 30000);
  return {
    id: str(b.id, 100),
    meetingId: str(b.meetingId, 100),
    speakerId: str(b.speakerId, 100),
    text: str(b.text, 8000),
    startTime,
    endTime,
    confidence: num(b.confidence, 0, 1),
  };
}
@Controller("api")
class Api {
  @All("*path") async route(@Req() req: Request, @Res() res: Response) {
    if (req.headers.origin && !allowed.has(req.headers.origin))
      return res.status(403).json({ error: "Origem não permitida" });
    if (!auth(req.headers.authorization?.replace(/^Bearer /, "")))
      return res.status(401).json({ error: "Código de acesso inválido" });
    const path = req.path.replace(/^\/api\//, ""),
      b = req.body ?? {};
    try {
      if (req.method === "GET") {
        if (path === "state") return res.json(state.data);
        if (path === "health")
          return res.json({
            ok: true,
            mode: infra ? "infra" : "memory",
            capture: "explicit-browser-only",
            ai: "local-heuristic",
          });
        const c = path.match(/^events\/([^/]+)\/context$/);
        if (c) return res.json(state.context(c[1]));
      }
      if (req.method === "POST") {
        if (path === "demo/start") {
          state.startDemo(infra ? (s) => infra!.publish(s) : undefined);
          return res.json({ ok: true });
        }
        if (path === "stop") {
          state.stop();
          return res.json({ ok: true });
        }
        if (path === "reset") {
          state.reset();
          return res.json({ ok: true });
        }
        if (path === "focus") {
          state.focus(b.id === null ? null : str(b.id));
          return res.json({ ok: true });
        }
        if (path === "interaction") {
          state.interact(str(b.id));
          return res.json({ ok: true });
        }
        if (path === "profile") {
          state.profile(profile(b));
          return res.json({ ok: true });
        }
        if (path === "settings") {
          const weights = { ...state.data.settings.weights };
          if (b.weights) {
            for (const key of Object.keys(b.weights)) {
              if (!EVENT_TYPES.includes(key as (typeof EVENT_TYPES)[number]))
                throw Error("Peso desconhecido");
              weights[key as (typeof EVENT_TYPES)[number]] = num(
                b.weights[key],
                0,
                2,
              );
            }
          }
          state.settings({
            minAttentionDelta: num(b.minAttentionDelta, 1, 100),
            cooldownMs: num(b.cooldownMs, 1000, 600000),
            retentionHours: num(b.retentionHours, 1, 720),
            weights,
            urgentSound: bool(
              b.urgentSound,
              state.data.settings.urgentSound ?? false,
            ),
          });
          return res.json({ ok: true });
        }
        if (path === "meetings") {
          return res.json({ id: state.create(str(b.title), str(b.platform)) });
        }
        if (path === "capture/start") {
          state.stop();
          state.data.running = true;
          state.data.demo = false;
          state.emit();
          return res.json({ ok: true });
        }
        if (path === "transcript") {
          if (!state.data.running || state.data.demo)
            throw Error("Captura real não está ativa");
          const s = segment(b);
          if (infra) await infra.publish(s);
          else state.ingest(s);
          return res.json({ ok: true });
        }
        const e = path.match(/^events\/([^/]+)\/(status|response|feedback)$/);
        if (e) {
          if (e[2] === "response") return res.json(state.response(e[1]));
          if (e[2] === "feedback") {
            if (!["useful", "unimportant", "false-positive"].includes(b.rating))
              throw Error("Feedback inválido");
            state.feedback(
              e[1],
              b.rating,
              typeof b.reason === "string" ? b.reason.slice(0, 1000) : "",
            );
          } else state.transition(e[1], b.status as EventStatus);
          return res.json({ ok: true });
        }
        const m = path.match(/^meetings\/([^/]+)\/(catch-up|end|clear)$/);
        if (m) {
          if (m[2] === "catch-up")
            return res.json(state.catchUp(m[1], b.ultra === true));
          if (m[2] === "end") return res.json(state.end(m[1]));
          state.clearTranscript(m[1]);
          return res.json({ ok: true });
        }
      }
      if (req.method === "DELETE") {
        const m = path.match(/^meetings\/([^/]+)$/);
        if (m) {
          state.delete(m[1]);
          return res.json({ ok: true });
        }
      }
      return res.status(404).json({ error: "Rota inexistente" });
    } catch (error) {
      return res
        .status(400)
        .json({
          error:
            error instanceof Error ? error.message : "Solicitação inválida",
        });
    }
  }
}
@Module({ controllers: [Api] })
class AppModule {}
async function main() {
  if (process.env.STORAGE_MODE === "infra") {
    infra = new Infrastructure();
    await infra.connect();
    const saved = await infra.load();
    if (saved) {
      state.data = saved;
      state.data.running = false;
    }
    await infra.consume((s) =>
      state.ingest(segment(s as unknown as Record<string, unknown>)),
    );
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn"],
  });
  app.enableCors({
    origin: [...allowed],
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  app.useBodyParser("json", { limit: "64kb" });
  const io = new Server(app.getHttpServer(), {
    cors: { origin: [...allowed] },
    maxHttpBufferSize: 65536,
  });
  io.use((socket, next) =>
    auth(socket.handshake.auth.token) &&
    (!socket.handshake.headers.origin ||
      allowed.has(socket.handshake.headers.origin))
      ? next()
      : next(Error("Unauthorized")),
  );
  io.on("connection", (s) => {
    s.emit("state", state.data);
  });
  state.listeners.add(() => {
    io.emit("state", state.data);
    if (infra)
      void infra
        .save(state.data)
        .catch(() =>
          console.error(
            JSON.stringify({
              timestamp: Date.now(),
              type: "persistence_failure",
            }),
          ),
        );
  });
  app.useStaticAssets(resolve("dist-ui"));
  await app.listen(port, "127.0.0.1");
  const interval = setInterval(() => state.tick(), 5000);
  console.log(
    `Attention Copilot: http://127.0.0.1:${port}`,
  );
  console.log(`Código de acesso local: ${token}`);
  const shutdown = async () => {
    clearInterval(interval);
    state.stop();
    await infra?.close();
    io.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
main().catch((error: unknown) => {
  console.error(
    "Não foi possível iniciar. Confira infraestrutura e variáveis de ambiente.",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
