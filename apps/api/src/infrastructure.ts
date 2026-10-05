import { Pool } from "pg";
import { createClient } from "redis";
import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from "amqplib";
import type {
  AppState,
  TranscriptSegment,
} from "../../../packages/core/src/types.js";
const queues = [
  "meeting.audio",
  "meeting.transcript",
  "meeting.context",
  "meeting.attention",
  "meeting.notification",
  "meeting.summary",
  "meeting.tasks",
];
export class Infrastructure {
  pool?: Pool;
  redis?: ReturnType<typeof createClient>;
  connection?: ChannelModel;
  channel?: ConfirmChannel;
  private tail = Promise.resolve();
  async connect() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await this.pool.query("SELECT 1");
    this.redis = createClient({ url: process.env.REDIS_URL });
    this.redis.on("error", () =>
      console.error(
        JSON.stringify({ timestamp: Date.now(), type: "redis_error" }),
      ),
    );
    await this.redis.connect();
    this.connection = await amqp.connect(process.env.AMQP_URL!);
    this.channel = await this.connection.createConfirmChannel();
    await this.channel.prefetch(4);
    for (const q of queues) {
      await this.channel.assertQueue(`${q}.dlq`, { durable: true });
      await this.channel.assertQueue(q, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": `${q}.dlq`,
        },
      });
    }
  }
  async load(): Promise<AppState | undefined> {
    const result = await this.pool!.query(
      "SELECT data FROM app_snapshot WHERE id=1",
    );
    return result.rows[0]?.data;
  }
  /** Rows already in PostgreSQL: segment ids, and event id → row signature. */
  private savedSegments = new Set<string>();
  private savedEvents = new Map<string, string>();
  private synced = false;
  private latest?: AppState;
  private queued?: Promise<void>;
  /** Coalesces bursts: at most one write runs and one waits, always with the newest state. */
  save(state: AppState) {
    this.latest = state;
    if (!this.queued) {
      this.queued = this.tail
        .catch(() => {})
        .then(() => {
          this.queued = undefined;
          return this.write(structuredClone(this.latest!));
        });
      this.tail = this.queued;
    }
    return this.tail;
  }
  private async write(snapshot: AppState) {
    const segments = snapshot.meetings.flatMap((m) => m.transcript),
      events = snapshot.meetings.flatMap((m) => m.events),
      eventSignature = (e: (typeof events)[number]) =>
        JSON.stringify([e.status, e.score, e.updatedAt, e.feedback]);
    const newSegments = segments.filter((s) => !this.savedSegments.has(s.id)),
      changedEvents = events.filter(
        (e) => this.savedEvents.get(e.id) !== eventSignature(e),
      ),
      currentSegments = new Set(segments.map((s) => s.id)),
      currentEvents = new Set(events.map((e) => e.id)),
      goneSegments = [...this.savedSegments.keys()].filter(
        (id) => !currentSegments.has(id),
      ),
      goneEvents = [...this.savedEvents.keys()].filter(
        (id) => !currentEvents.has(id),
      );
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO app_snapshot(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [snapshot],
      );
      await client.query(
        "INSERT INTO app_user(id,profile) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile",
        ["local", snapshot.profile],
      );
      await client.query(
        "DELETE FROM meeting WHERE NOT (id = ANY($1::text[]))",
        [snapshot.meetings.map((m) => m.id)],
      );
      // Transcript and events live in their own tables; keep meeting.data small.
      await client.query(
        `INSERT INTO meeting(id,user_id,title,platform,data)
         SELECT x->>'id','local',x->>'title',x->>'platform',x FROM jsonb_array_elements($1::jsonb) x
         ON CONFLICT(id) DO UPDATE SET data=excluded.data,title=excluded.title,platform=excluded.platform`,
        [
          JSON.stringify(
            snapshot.meetings.map(({ transcript, events, ...m }) => m),
          ),
        ],
      );
      if (!this.synced) {
        // First write after startup: drop rows the in-memory state no longer has.
        await client.query(
          "DELETE FROM transcript_segment WHERE NOT (id = ANY($1::text[]))",
          [[...currentSegments]],
        );
        await client.query(
          "DELETE FROM attention_event WHERE NOT (id = ANY($1::text[]))",
          [[...currentEvents]],
        );
      }
      if (goneSegments.length)
        await client.query(
          "DELETE FROM transcript_segment WHERE id = ANY($1::text[])",
          [goneSegments],
        );
      if (goneEvents.length)
        await client.query(
          "DELETE FROM attention_event WHERE id = ANY($1::text[])",
          [goneEvents],
        );
      if (newSegments.length)
        await client.query(
          `INSERT INTO transcript_segment(id,meeting_id,data)
           SELECT x->>'id',x->>'meetingId',x FROM jsonb_array_elements($1::jsonb) x
           ON CONFLICT(id) DO NOTHING`,
          [JSON.stringify(newSegments)],
        );
      if (changedEvents.length)
        await client.query(
          `INSERT INTO attention_event(id,meeting_id,score,status,data)
           SELECT x->>'id',x->>'meetingId',(x->>'score')::int,x->>'status',x FROM jsonb_array_elements($1::jsonb) x
           ON CONFLICT(id) DO UPDATE SET score=excluded.score,status=excluded.status,data=excluded.data`,
          [JSON.stringify(changedEvents)],
        );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // Caches advance only after COMMIT, so a failed write is retried in full.
    this.synced = true;
    for (const id of goneSegments) this.savedSegments.delete(id);
    for (const id of goneEvents) this.savedEvents.delete(id);
    for (const s of newSegments) this.savedSegments.add(s.id);
    for (const e of changedEvents) this.savedEvents.set(e.id, eventSignature(e));
    // Redis is a TTL cache; its failure must not roll back or redeliver transcripts.
    await this.redis!.set(
      "attention:state",
      JSON.stringify({
        focusId: snapshot.focusId,
        scores: snapshot.meetings.map((m) => ({
          id: m.id,
          score: m.attentionScore,
        })),
      }),
      { EX: 3600 },
    ).catch(() =>
      console.error(
        JSON.stringify({ timestamp: Date.now(), type: "redis_cache_failure" }),
      ),
    );
  }
  async publish(s: TranscriptSegment) {
    this.channel!.sendToQueue(
      "meeting.transcript",
      Buffer.from(JSON.stringify(s)),
      {
        persistent: true,
        messageId: s.id,
        correlationId: s.id,
        headers: { attempt: 0 },
      },
    );
    await this.channel!.waitForConfirms();
  }
  async consume(handler: (s: TranscriptSegment) => void) {
    const chains = new Map<string, Promise<void>>();
    await this.channel!.consume(
      "meeting.transcript",
      (msg: ConsumeMessage | null) => {
        if (!msg) return;
        let s: TranscriptSegment;
        try {
          s = JSON.parse(msg.content.toString());
          if (!s.id || !s.meetingId || typeof s.text !== "string")
            throw Error();
        } catch {
          this.channel!.nack(msg, false, false);
          return;
        }
        const prior = chains.get(s.meetingId) ?? Promise.resolve();
        const next = prior
          .catch(() => {})
          .then(async () => {
            try {
              handler(s);
              await this.tail;
              this.channel!.ack(msg);
            } catch {
              const attempt = Number(msg.properties.headers?.attempt ?? 0);
              if (attempt >= 3) {
                this.channel!.nack(msg, false, false);
                return;
              }
              this.channel!.sendToQueue("meeting.transcript", msg.content, {
                ...msg.properties,
                headers: { attempt: attempt + 1 },
              });
              await this.channel!.waitForConfirms();
              this.channel!.ack(msg);
            }
          });
        chains.set(s.meetingId, next);
        void next.finally(() => {
          if (chains.get(s.meetingId) === next) chains.delete(s.meetingId);
        });
      },
    );
  }
  async close() {
    await this.tail.catch(() => {});
    await this.connection?.close();
    await this.redis?.quit();
    await this.pool?.end();
  }
}
