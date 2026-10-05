export const EVENT_TYPES = [
  "NONE",
  "MENTION",
  "DIRECT_QUESTION",
  "INDIRECT_QUESTION",
  "TASK_ASSIGNED",
  "TASK_DISCUSSION",
  "DECISION_REQUIRED",
  "USER_RESPONSIBILITY",
  "USER_TOPIC",
  "USER_EXPERTISE_REQUIRED",
  "DEADLINE",
  "BLOCKER",
  "URGENT_REQUEST",
  "FOLLOW_UP",
  "IMPORTANT_CONTEXT",
  "CONFLICT",
  "APPROVAL_REQUIRED",
  "CONFIRMATION_REQUIRED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type AttentionLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type EventStatus =
  | "DETECTED"
  | "NOTIFIED"
  | "SEEN"
  | "ACKNOWLEDGED"
  | "RESPONDED"
  | "DISMISSED"
  | "EXPIRED";
export interface UserProfile {
  name: string;
  fullName: string;
  aliases: string[];
  role: string;
  teams: string[];
  projects: { name: string; importance: number }[];
  expertise: string[];
  people: { name: string; importance: number }[];
}
export interface TranscriptSegment {
  id: string;
  meetingId: string;
  speakerId: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
}
export interface AttentionDecision {
  meetingId: string;
  score: number;
  level: AttentionLevel;
  reason: string;
  requiresResponse: boolean;
  requiresImmediateAttention: boolean;
  recommendedAction: string;
  confidence: number;
}
export interface AttentionEvent extends AttentionDecision {
  id: string;
  types: EventType[];
  status: EventStatus;
  segmentIds: string[];
  detectedAt: number;
  updatedAt: number;
  notifiedAt?: number;
  notifiedScore?: number;
  repeats: number;
  quote: string;
  topic: string;
  feedback?: {
    rating: "useful" | "unimportant" | "false-positive";
    reason: string;
  };
}
export interface Meeting {
  id: string;
  title: string;
  platform: string;
  startedAt: number;
  endedAt?: number;
  status: "SCHEDULED" | "ACTIVE" | "PAUSED" | "ENDED";
  participants: string[];
  attentionScore: number;
  lastUserAttentionAt: number;
  catchUpSince?: number;
  catchUpUntil?: number;
  lastRelevantEventAt?: number;
  transcript: TranscriptSegment[];
  events: AttentionEvent[];
}
export interface Settings {
  minAttentionDelta: number;
  cooldownMs: number;
  expireMs: number;
  retentionHours: number;
  weights: Record<EventType, number>;
  /** Soft tone for URGENT alerts; off by default. */
  urgentSound: boolean;
}
/** CALM 🟢 · POSSIBLE 🟡 (relevant but not certain enough to switch) · SWITCH 🔴 */
export type RecommendationState = "CALM" | "POSSIBLE" | "SWITCH";
export interface Recommendation {
  meetingId: string | null;
  switchAttention: boolean;
  state: RecommendationState;
  /** Event behind a POSSIBLE/SWITCH recommendation, for "Ver contexto". */
  eventId?: string;
  reason: string;
  confidence: number;
}
/** How an open event reaches the user (§17): never louder than the engine decided. */
export type AlertChannel = "NONE" | "BADGE" | "DISCREET" | "DESKTOP" | "URGENT";
export interface AppState {
  meetings: Meeting[];
  profile: UserProfile;
  settings: Settings;
  focusId: string | null;
  focusMode: "MANUAL" | "AUTO";
  running: boolean;
  demo: boolean;
  recommendation: Recommendation;
}
export interface Detection {
  types: EventType[];
  score: number;
  confidence: number;
  requiresResponse: boolean;
  reason: string;
  topic: string;
  /** Explicit "no longer needed" statement; may resolve an open event. */
  dismissal?: boolean;
}
export const defaultProfile: UserProfile = {
  name: "Nataniel",
  fullName: "Nataniel",
  aliases: ["Natan", "Nathan"],
  role: "Senior Software Engineer",
  teams: [],
  projects: [],
  expertise: ["PHP", "Laravel", "Node.js", "NestJS", "React", "Angular", "AWS"],
  people: [],
};
export const defaultSettings: Settings = {
  minAttentionDelta: 25,
  cooldownMs: 30000,
  expireMs: 15 * 60000,
  retentionHours: 24,
  weights: Object.fromEntries(EVENT_TYPES.map((t) => [t, 1])) as Record<
    EventType,
    number
  >,
  urgentSound: false,
};
