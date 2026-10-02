import type { Config, Context } from "@netlify/functions";
import { and, asc, count, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { messageStars, messages, users } from "../../db/schema.js";
import {
  MAX_STARS,
  ONLINE_WINDOW_MS,
  PRESENCE_THROTTLE_MS,
  SYSTEM_MESSAGE_DAYS,
  USER_MESSAGE_DAYS,
  bump,
  chatEpoch,
  currentUser,
  expiryFor,
  fail,
  getSettings,
  json,
  tooMany,
  secondsUntil,
} from "../lib/core.js";

const MAX_BODY = 500;
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MAX = 8; // messages per window per person

async function listMessages(userId: number, after: number) {
  // Did this person star the message? (stars are personal)
  const starred = sql<boolean>`exists (select 1 from ${messageStars} where ${messageStars.messageId} = ${messages.id} and ${messageStars.userId} = ${userId})`;
  const base = db
    .select({
      id: messages.id,
      body: messages.body,
      kind: messages.kind,
      createdAt: messages.createdAt,
      name: users.name,
      isAdmin: users.isAdmin,
      starred,
    })
    .from(messages)
    .leftJoin(users, eq(messages.userId, users.id));
  // Expired messages are hidden here, even before the housekeeping job physically deletes them.
  const live = gt(messages.expiresAt, new Date());
  if (after > 0) {
    return base.where(and(live, gt(messages.id, after))).orderBy(asc(messages.id)).limit(200);
  }
  const latest = await base.where(live).orderBy(desc(messages.id)).limit(100);
  return latest.reverse();
}

async function onlineUsers() {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS);
  const rows = await db
    .select({ name: users.name })
    .from(users)
    .where(and(gte(users.lastSeenAt, since), eq(users.banned, false)))
    .orderBy(asc(users.name));
  return rows.map((r) => r.name);
}

// "Last seen" is written at most once per PRESENCE_THROTTLE_MS per person, not on every 2s poll.
async function touchPresence(userId: number) {
  await db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(users.id, userId), lt(users.lastSeenAt, new Date(Date.now() - PRESENCE_THROTTLE_MS))));
}

async function listSaved(userId: number) {
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      kind: messages.kind,
      createdAt: messages.createdAt,
      name: users.name,
      isAdmin: users.isAdmin,
      savedAt: messageStars.createdAt,
    })
    .from(messageStars)
    .innerJoin(messages, eq(messageStars.messageId, messages.id))
    .leftJoin(users, eq(messages.userId, users.id))
    .where(eq(messageStars.userId, userId))
    .orderBy(desc(messageStars.createdAt))
    .limit(MAX_STARS);
  return json({ messages: rows });
}

async function star(userId: number, messageId: number) {
  const [msg] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), gt(messages.expiresAt, new Date())));
  if (!msg) return fail("Mensagem não encontrada ou já expirou.", 404);
  const [{ n }] = await db.select({ n: count() }).from(messageStars).where(eq(messageStars.userId, userId));
  if (n >= MAX_STARS) return fail(`Limite de ${MAX_STARS} mensagens salvas. Remova alguma para salvar outra.`, 409);
  await db.insert(messageStars).values({ userId, messageId }).onConflictDoNothing();
  return json({ ok: true, starred: true });
}

async function unstar(userId: number, messageId: number) {
  await db.delete(messageStars).where(and(eq(messageStars.userId, userId), eq(messageStars.messageId, messageId)));
  return json({ ok: true, starred: false });
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);

  // Public: what the landing page needs to decide what to render.
  if (url.pathname === "/api/config") {
    const s = await getSettings();
    return json({
      construction: s.construction === "true",
      title: s.title,
      motd: s.motd,
      constructionText: s.constructionText,
      retention: { userDays: USER_MESSAGE_DAYS, systemDays: SYSTEM_MESSAGE_DAYS },
    });
  }

  const user = await currentUser(req);
  if (!user) return fail("Faça login para continuar.", 401);

  const s = await getSettings();
  if (s.construction === "true" && !user.isAdmin) {
    return fail("O chat está em construção. Volte em breve.", 503);
  }

  if (url.pathname === "/api/stars") {
    if (req.method === "GET") return listSaved(user.id);
    return fail("Método não permitido.", 405);
  }

  if (url.pathname.startsWith("/api/stars/")) {
    const id = Number(context.params?.id ?? 0);
    if (!Number.isInteger(id) || id <= 0) return fail("Mensagem inválida.");
    if (req.method === "PUT") return star(user.id, id);
    if (req.method === "DELETE") return unstar(user.id, id);
    return fail("Método não permitido.", 405);
  }

  if (req.method === "GET") {
    await touchPresence(user.id);
    const after = Number(url.searchParams.get("after") ?? 0) || 0;
    const epoch = await chatEpoch();
    // The client sends the epoch it last saw. If messages vanished since (deleted by an admin, or a day
    // ended at 00:00), send the whole recent list again so the screen matches the server.
    const reset = after <= 0 || url.searchParams.get("epoch") !== epoch;
    const [list, online] = await Promise.all([listMessages(user.id, reset ? 0 : after), onlineUsers()]);
    return json({ reset, epoch, messages: list, online });
  }

  if (req.method === "POST") {
    const flood = await bump(`msg:${user.id}`, FLOOD_WINDOW_MS);
    if (flood.count > FLOOD_MAX) return tooMany(secondsUntil(flood.resetAt));
    const { body } = (await req.json().catch(() => ({}))) as { body?: string };
    const text = (body ?? "").trim();
    if (!text) return fail("Mensagem vazia.");
    if (text.length > MAX_BODY) return fail(`Mensagem muito longa (máx. ${MAX_BODY} caracteres).`);
    const [msg] = await db.insert(messages).values({ userId: user.id, body: text, expiresAt: expiryFor("user") }).returning();
    return json({ id: msg.id }, 201);
  }

  return fail("Método não permitido.", 405);
};

export const config: Config = {
  path: ["/api/config", "/api/messages", "/api/stars", "/api/stars/:id"],
};
