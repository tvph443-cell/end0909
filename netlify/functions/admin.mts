import type { Config, Context } from "@netlify/functions";
import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { messages, sessions, settings, users } from "../../db/schema.js";
import { SETTING_KEYS, currentUser, fail, getSettings, json, type SettingKey } from "../lib/core.js";

async function updateSettings(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<Record<SettingKey, unknown>>;
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    const raw = body[key];
    const value = key === "construction" ? String(raw === true || raw === "true") : String(raw ?? "").slice(0, 1000);
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }
  return json(await getSettings());
}

async function listUsers() {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      isAdmin: users.isAdmin,
      banned: users.banned,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      messageCount: sql<number>`(select count(*)::int from ${messages} where ${messages.userId} = ${users.id})`,
    })
    .from(users)
    .orderBy(desc(users.lastSeenAt));
  return json({ users: rows });
}

async function updateUser(req: Request, id: number, adminId: number) {
  const body = (await req.json().catch(() => ({}))) as { banned?: boolean; isAdmin?: boolean };
  if (id === adminId && (body.banned === true || body.isAdmin === false)) {
    return fail("Você não pode bloquear nem remover o próprio acesso de admin.");
  }
  const patch: Partial<typeof users.$inferInsert> = {};
  if (typeof body.banned === "boolean") patch.banned = body.banned;
  if (typeof body.isAdmin === "boolean") patch.isAdmin = body.isAdmin;
  if (Object.keys(patch).length === 0) return fail("Nada para atualizar.");
  await db.update(users).set(patch).where(eq(users.id, id));
  if (patch.banned) await db.delete(sessions).where(eq(sessions.userId, id));
  return json({ ok: true });
}

export default async (req: Request, context: Context) => {
  const admin = await currentUser(req);
  if (!admin) return fail("Faça login como administrador.", 401);
  if (!admin.isAdmin) return fail("Acesso restrito ao administrador.", 403);

  const path = new URL(req.url).pathname;
  const id = Number(context.params?.id ?? 0);

  if (path === "/api/admin/settings") {
    if (req.method === "GET") return json(await getSettings());
    if (req.method === "PUT") return updateSettings(req);
  }

  if (path === "/api/admin/stats" && req.method === "GET") {
    const [[u], [m]] = await Promise.all([
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(messages),
    ]);
    return json({ users: u.n, messages: m.n });
  }

  if (path === "/api/admin/users" && req.method === "GET") return listUsers();

  if (path.startsWith("/api/admin/users/") && id) {
    if (req.method === "PATCH") return updateUser(req, id, admin.id);
    if (req.method === "DELETE") {
      if (id === admin.id) return fail("Você não pode apagar a própria conta.");
      // Deleting a user frees the name so it can be claimed again.
      await db.delete(users).where(eq(users.id, id));
      return json({ ok: true });
    }
  }

  if (path === "/api/admin/messages") {
    if (req.method === "GET") {
      const rows = await db
        .select({ id: messages.id, body: messages.body, kind: messages.kind, createdAt: messages.createdAt, name: users.name })
        .from(messages)
        .leftJoin(users, eq(messages.userId, users.id))
        .orderBy(desc(messages.id))
        .limit(200);
      return json({ messages: rows });
    }
    if (req.method === "POST") {
      const { body } = (await req.json().catch(() => ({}))) as { body?: string };
      const text = (body ?? "").trim().slice(0, 500);
      if (!text) return fail("Aviso vazio.");
      await db.insert(messages).values({ body: text, kind: "system" });
      return json({ ok: true }, 201);
    }
    if (req.method === "DELETE") {
      await db.delete(messages);
      return json({ ok: true });
    }
  }

  if (path.startsWith("/api/admin/messages/") && id && req.method === "DELETE") {
    await db.delete(messages).where(eq(messages.id, id));
    return json({ ok: true });
  }

  return fail("Rota não encontrada.", 404);
};

export const config: Config = {
  path: [
    "/api/admin/settings",
    "/api/admin/stats",
    "/api/admin/users",
    "/api/admin/users/:id",
    "/api/admin/messages",
    "/api/admin/messages/:id",
  ],
};
