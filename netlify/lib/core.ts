import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sessions, settings, users } from "../../db/schema.js";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type User = typeof users.$inferSelect;

// Defaults for every admin-editable setting. Stored rows override these.
export const DEFAULT_SETTINGS = {
  construction: "true",
  title: "TERMINAL//CHAT",
  motd: "Bem-vindo ao terminal. Digite /ajuda para ver os comandos.",
  constructionText: "Em construção.",
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export const NAME_RE = /^[\p{L}\p{N}_.-]{2,20}$/u;

export const json = (data: unknown, status = 200) => Response.json(data, { status });
export const fail = (message: string, status = 400) => json({ error: message }, status);

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

export async function createSession(userId: number) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({ token, userId });
  return token;
}

export function bearer(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

export async function currentUser(req: Request): Promise<User | null> {
  const token = bearer(req);
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token));
  if (!row || row.user.banned) return null;
  return row.user;
}

export async function getSettings(): Promise<Record<SettingKey, string>> {
  const rows = await db.select().from(settings).where(inArray(settings.key, SETTING_KEYS));
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out as Record<SettingKey, string>;
}

export const publicUser = (u: User) => ({ id: u.id, name: u.name, isAdmin: u.isAdmin });
