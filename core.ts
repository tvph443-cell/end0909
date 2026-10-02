import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { messageStars, messages, rateLimits, sessions, settings, users } from "../../db/schema.js";
import { chatTimeZone, localDayKey, midnightAfterDays } from "./time.js";

export { chatTimeZone };

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type User = typeof users.$inferSelect;

/* ---------- Settings ---------- */

// Defaults for every admin-editable setting. Stored rows override these.
export const DEFAULT_SETTINGS = {
  construction: "true",
  title: "TERMINAL//CHAT",
  motd: "Bem-vindo ao terminal. Digite /ajuda para ver os comandos.",
  constructionText: "Em construção.",
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export async function getSettings(): Promise<Record<SettingKey, string>> {
  const rows = await db.select().from(settings).where(inArray(settings.key, SETTING_KEYS));
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out as Record<SettingKey, string>;
}

/* ---------- Rules (tweak here) ---------- */

export const USER_MESSAGE_DAYS = 30; // normal messages: calendar days, each ending at 00:00
export const SYSTEM_MESSAGE_DAYS = 365; // admin announcements stay much longer
export const MAX_STARS = 500; // saved messages per person
export const MAX_SESSIONS_PER_USER = 10; // devices signed in at once; the oldest is dropped
export const MIN_PASSWORD = 6;
export const MIN_ADMIN_PASSWORD = 10;
export const ONLINE_WINDOW_MS = 60_000;
export const PRESENCE_THROTTLE_MS = 20_000; // how often "last seen" is written per person

export const NAME_RE = /^[\p{L}\p{N}_.-]{2,20}$/u;

// Nobody can claim these through the normal login; the admin account is created through /api/setup.
export const RESERVED_NAMES = new Set([
  "admin", "administrador", "administrator", "root", "sistema", "system", "moderador", "moderator", "mod", "suporte", "support", "staff",
]);

const COMMON_PASSWORDS = new Set([
  "123456", "1234567", "12345678", "123456789", "1234567890", "000000", "111111", "123123", "654321", "password", "senha", "senha123", "qwerty", "abc123", "admin", "admin123",
]);

export function passwordProblem(password: string, name: string, min = MIN_PASSWORD): string | null {
  if (password.length < min) return `A senha precisa ter pelo menos ${min} caracteres.`;
  if (password.length > 200) return "Senha muito longa (máx. 200 caracteres).";
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return "Essa senha é comum demais. Escolha outra.";
  if (lower === name.toLowerCase()) return "A senha não pode ser igual ao nome.";
  return null;
}

/* ---------- HTTP helpers ---------- */

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
export const fail = (message: string, status = 400, headers: Record<string, string> = {}) =>
  json({ error: message }, status, headers);

export function clientIp(req: Request, context?: { ip?: string }) {
  return context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
}

/* ---------- Passwords ---------- */

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [saltHex, keyHex] = stored.split(":");
  const expected = Buffer.from(keyHex, "hex");
  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(key, expected);
}

/** Constant-time string comparison (hashes first so lengths don't leak). */
export function safeEqual(a: string, b: string) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/* ---------- Sessions ----------
 * Login sets an HttpOnly cookie that stays valid until the person logs out (or an admin ends it).
 * The cookie is re-issued on /api/me, so each visit pushes its browser expiry another 400 days out.
 */

export const SESSION_COOKIE = "tc_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // browsers cap cookie lifetime at about 400 days

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function sessionCookie(req: Request, token: string, maxAge = COOKIE_MAX_AGE) {
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

export const clearedCookie = (req: Request) => sessionCookie(req, "", 0);

export async function createSession(userId: number, req: Request) {
  const token = randomBytes(32).toString("hex");
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 200) || null;
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, userAgent });

  // Keep only the most recently used devices.
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.lastUsedAt), desc(sessions.id));
  const stale = rows.slice(MAX_SESSIONS_PER_USER).map((r) => r.id);
  if (stale.length) await db.delete(sessions).where(inArray(sessions.id, stale));
  return token;
}

export async function currentSession(req: Request) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [row] = await db
    .select({ user: users, sessionId: sessions.id, lastUsedAt: sessions.lastUsedAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, hashToken(token)));
  if (!row || row.user.banned) return null;
  if (Date.now() - row.lastUsedAt.getTime() > 60 * 60 * 1000) {
    await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }
  return { user: row.user, sessionId: row.sessionId, token };
}

export async function currentUser(req: Request): Promise<User | null> {
  return (await currentSession(req))?.user ?? null;
}

/** Ends the session behind the request's cookie (if any). */
export async function destroySession(req: Request) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export const publicUser = (u: User) => ({ id: u.id, name: u.name, isAdmin: u.isAdmin });

/* ---------- Rate limiting (fixed windows kept in the database) ---------- */

export type Limit = { key: string; max: number };
export const FAIL_WINDOW_MS = 15 * 60 * 1000;

/** Seconds until the person may try again, or 0 when none of the limits is exhausted. */
export async function blockedFor(limits: Limit[]): Promise<number> {
  const rows = await db.select().from(rateLimits).where(inArray(rateLimits.key, limits.map((l) => l.key)));
  const now = Date.now();
  let wait = 0;
  for (const l of limits) {
    const r = rows.find((x) => x.key === l.key);
    if (r && r.resetAt.getTime() > now && r.count >= l.max) wait = Math.max(wait, Math.ceil((r.resetAt.getTime() - now) / 1000));
  }
  return wait;
}

/** Adds one hit to a counter (starting a new window when the old one ended) and returns it. */
export async function bump(key: string, windowMs = FAIL_WINDOW_MS) {
  const resetAt = new Date(Date.now() + windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.resetAt} <= now() then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${rateLimits.resetAt} <= now() then ${resetAt.toISOString()}::timestamptz else ${rateLimits.resetAt} end`,
      },
    })
    .returning();
  return row;
}

export async function clearLimit(key: string) {
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
}

export const secondsUntil = (d: Date) => Math.max(1, Math.ceil((d.getTime() - Date.now()) / 1000));

export function tooMany(wait: number) {
  const text = wait > 90 ? `${Math.ceil(wait / 60)} min` : `${wait} s`;
  return fail(`Muitas tentativas. Tente de novo em ${text}.`, 429, { "retry-after": String(wait) });
}

/* ---------- Message retention ---------- */

export const retentionDays = (kind: string) => (kind === "system" ? SYSTEM_MESSAGE_DAYS : USER_MESSAGE_DAYS);
export const expiryFor = (kind: string, from = new Date()) => midnightAfterDays(from, retentionDays(kind));

/*
 * "Epoch" of the shared chat. It changes whenever messages disappear for everyone — an admin deletes
 * something, or a day ends at 00:00 and old messages expire — so open tabs know to reload their list.
 */
const EPOCH_KEY = "chat_epoch";

export async function chatEpoch() {
  const [row] = await db.select().from(settings).where(eq(settings.key, EPOCH_KEY));
  return `${row?.value ?? "0"}|${localDayKey()}`;
}

export async function bumpChatEpoch() {
  await db
    .insert(settings)
    .values({ key: EPOCH_KEY, value: "1" })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`((${settings.value})::int + 1)::text` } });
}

/**
 * Physically removes what is no longer needed: expired messages that nobody starred, and old
 * rate-limit counters. Expired messages are already hidden from the chat by `expires_at`; this is housekeeping.
 */
export async function purgeExpired() {
  const gone = await db
    .delete(messages)
    .where(
      and(
        lte(messages.expiresAt, new Date()),
        sql`not exists (select 1 from ${messageStars} where ${messageStars.messageId} = ${messages.id})`,
      ),
    )
    .returning({ id: messages.id });
  await db.delete(rateLimits).where(lte(rateLimits.resetAt, new Date(Date.now() - 60 * 60 * 1000)));
  return { messages: gone.length };
}
