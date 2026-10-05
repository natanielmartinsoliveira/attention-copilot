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
  save(state: AppState) {
    const snapshot = structuredClone(state);
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
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
          for (const m of snapshot.meetings) {
            await client.query(
              "INSERT INTO meeting(id,user_id,title,platform,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=excluded.data,title=excluded.title,platform=excluded.platform",
              [m.id, "local", m.title, m.platform, m],
            );
            await client.query(
              "DELETE FROM transcript_segment WHERE meeting_id=$1",
              [m.id],
            );
            await client.query(
              "DELETE FROM attention_event WHERE meeting_id=$1",
              [m.id],
            );
            for (const s of m.transcript)
              await client.query(
                "INSERT INTO transcript_segment(id,meeting_id,data) VALUES($1,$2,$3)",
                [s.id, m.id, s],
              );
            for (const e of m.events)
              await client.query(
                "INSERT INTO attention_event(id,meeting_id,score,status,data) VALUES($1,$2,$3,$4,$5)",
                [e.id, m.id, e.score, e.status, e],
              );
          }
          await client.query("COMMIT");
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
          );
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      });
    return this.tail;
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
