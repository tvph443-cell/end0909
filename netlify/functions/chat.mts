import type { Config } from "@netlify/functions";
import { and, asc, desc, eq, gt, gte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { messages, users } from "../../db/schema.js";
import { currentUser, fail, getSettings, json } from "../lib/core.js";

const ONLINE_WINDOW_MS = 60_000;
const MAX_BODY = 500;

const messageFields = {
  id: messages.id,
  body: messages.body,
  kind: messages.kind,
  createdAt: messages.createdAt,
  name: users.name,
  isAdmin: users.isAdmin,
};

async function listMessages(after: number) {
  const base = db.select(messageFields).from(messages).leftJoin(users, eq(messages.userId, users.id));
  if (after > 0) {
    return base.where(gt(messages.id, after)).orderBy(asc(messages.id)).limit(200);
  }
  const latest = await base.orderBy(desc(messages.id)).limit(100);
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

export default async (req: Request) => {
  const url = new URL(req.url);

  // Public: what the landing page needs to decide what to render.
  if (url.pathname === "/api/config") {
    const s = await getSettings();
    return json({
      construction: s.construction === "true",
      title: s.title,
      motd: s.motd,
      constructionText: s.constructionText,
    });
  }

  const user = await currentUser(req);
  if (!user) return fail("Faça login para continuar.", 401);

  const s = await getSettings();
  if (s.construction === "true" && !user.isAdmin) {
    return fail("O chat está em construção. Volte em breve.", 503);
  }

  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));

  if (req.method === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0) || 0;
    const [list, online] = await Promise.all([listMessages(after), onlineUsers()]);
    return json({ messages: list, online });
  }

  if (req.method === "POST") {
    const { body } = (await req.json().catch(() => ({}))) as { body?: string };
    const text = (body ?? "").trim();
    if (!text) return fail("Mensagem vazia.");
    if (text.length > MAX_BODY) return fail(`Mensagem muito longa (máx. ${MAX_BODY} caracteres).`);
    const [msg] = await db.insert(messages).values({ userId: user.id, body: text }).returning();
    return json({ id: msg.id }, 201);
  }

  return fail("Método não permitido.", 405);
};

export const config: Config = {
  path: ["/api/config", "/api/messages"],
};
