import type { Config } from "@netlify/functions";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sessions, users } from "../../db/schema.js";
import {
  NAME_RE,
  bearer,
  createSession,
  currentUser,
  fail,
  getSettings,
  hashPassword,
  json,
  publicUser,
  verifyPassword,
} from "../lib/core.js";

// POST /api/login — a new name is claimed with whatever password is given;
// an existing name only opens with the password it was claimed with.
async function login(req: Request) {
  const { name, password } = (await req.json().catch(() => ({}))) as { name?: string; password?: string };
  const cleanName = (name ?? "").trim();
  if (!NAME_RE.test(cleanName)) {
    return fail("Nome inválido: use 2 a 20 letras, números, '.', '_' ou '-'.");
  }
  if (!password || password.length < 1 || password.length > 200) {
    return fail("Digite uma senha.");
  }

  const nameKey = cleanName.toLowerCase();
  let [user] = await db.select().from(users).where(eq(users.nameKey, nameKey));
  let created = false;

  if (user) {
    if (!(await verifyPassword(password, user.passwordHash))) {
      return fail("Senha incorreta para este nome.", 401);
    }
    if (user.banned) return fail("Este nome foi bloqueado pelo administrador.", 403);
  } else {
    // The very first claim of "admin" becomes the site administrator.
    const isAdmin = nameKey === "admin";
    const settings = await getSettings();
    if (settings.construction === "true" && !isAdmin) {
      return fail("O chat está em construção. Volte em breve.", 503);
    }
    const inserted = await db
      .insert(users)
      .values({ name: cleanName, nameKey, passwordHash: await hashPassword(password), isAdmin })
      .onConflictDoNothing()
      .returning();
    if (!inserted[0]) return fail("Este nome acabou de ser registrado. Tente novamente.", 409);
    user = inserted[0];
    created = true;
  }

  const settings = await getSettings();
  if (settings.construction === "true" && !user.isAdmin) {
    return fail("O chat está em construção. Volte em breve.", 503);
  }

  const token = await createSession(user.id);
  return json({ token, created, user: publicUser(user) });
}

export default async (req: Request) => {
  const path = new URL(req.url).pathname;

  if (path === "/api/login" && req.method === "POST") return login(req);

  if (path === "/api/logout" && req.method === "POST") {
    const token = bearer(req);
    if (token) await db.delete(sessions).where(eq(sessions.token, token));
    return json({ ok: true });
  }

  if (path === "/api/me" && req.method === "GET") {
    const user = await currentUser(req);
    return user ? json({ user: publicUser(user) }) : fail("Sessão expirada.", 401);
  }

  return fail("Rota não encontrada.", 404);
};

export const config: Config = {
  path: ["/api/login", "/api/logout", "/api/me"],
};
