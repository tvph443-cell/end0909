import type { Config, Context } from "@netlify/functions";
import { and, count, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sessions, users } from "../../db/schema.js";
import {
  FAIL_WINDOW_MS,
  MIN_ADMIN_PASSWORD,
  MIN_PASSWORD,
  NAME_RE,
  RESERVED_NAMES,
  blockedFor,
  bump,
  clearLimit,
  clearedCookie,
  clientIp,
  createSession,
  currentSession,
  destroySession,
  fail,
  getSettings,
  hashPassword,
  json,
  passwordProblem,
  publicUser,
  safeEqual,
  secondsUntil,
  sessionCookie,
  tooMany,
  verifyPassword,
} from "../lib/core.js";

const MAX_SIGNUPS_PER_HOUR = 5;

async function readBody<T>(req: Request) {
  return (await req.json().catch(() => ({}))) as Partial<T>;
}

const failLimits = (ip: string, nameKey: string) => [
  { key: `fail:${ip}|${nameKey}`, max: 5 }, // 5 wrong passwords for one name from one place
  { key: `fail:${ip}`, max: 20 }, // 20 wrong passwords from one place, any names
];

async function startSession(req: Request, user: typeof users.$inferSelect, extra: Record<string, unknown> = {}) {
  const token = await createSession(user.id, req);
  return json({ ...extra, user: publicUser(user) }, 200, { "set-cookie": sessionCookie(req, token) });
}

// POST /api/login — a new name is claimed with the password given; an existing name only opens with the
// password it was claimed with. The session then lasts until the person logs out.
// `adminOnly` (sent by /admin) never creates accounts and never opens a session for non-admins.
async function login(req: Request, ip: string) {
  const { name, password, adminOnly } = await readBody<{ name: string; password: string; adminOnly: boolean }>(req);
  const cleanName = (name ?? "").trim();
  if (!NAME_RE.test(cleanName)) {
    return fail("Nome inválido: use 2 a 20 letras, números, '.', '_' ou '-'.");
  }
  if (typeof password !== "string" || password.length < 1 || password.length > 200) {
    return fail("Digite uma senha.");
  }

  const nameKey = cleanName.toLowerCase();
  const limits = failLimits(ip, nameKey);
  const wait = await blockedFor(limits);
  if (wait) return tooMany(wait);

  const [existing] = await db.select().from(users).where(eq(users.nameKey, nameKey));
  const wrongPassword = async (message: string) => {
    await Promise.all(limits.map((l) => bump(l.key, FAIL_WINDOW_MS)));
    return fail(message, 401);
  };

  if (existing) {
    if (!(await verifyPassword(password, existing.passwordHash))) return wrongPassword("Senha incorreta para este nome.");
    if (existing.banned) return fail("Este nome foi bloqueado pelo administrador.", 403);
    if (adminOnly && !existing.isAdmin) return fail("Este nome não tem acesso de administrador.", 403);
    await clearLimit(limits[0].key);

    const settings = await getSettings();
    if (settings.construction === "true" && !existing.isAdmin) {
      return fail("O chat está em construção. Volte em breve.", 503);
    }
    return startSession(req, existing, { created: false });
  }

  // Unknown name.
  if (adminOnly) return wrongPassword("Nome ou senha incorretos.");
  if (RESERVED_NAMES.has(nameKey)) return fail("Este nome é reservado. Escolha outro.", 403);
  const settings = await getSettings();
  if (settings.construction === "true") return fail("O chat está em construção. Volte em breve.", 503);

  const problem = passwordProblem(password, cleanName, MIN_PASSWORD);
  if (problem) return fail(problem);

  const signups = await bump(`signup:${ip}`, 60 * 60 * 1000);
  if (signups.count > MAX_SIGNUPS_PER_HOUR) return tooMany(secondsUntil(signups.resetAt));

  const [created] = await db
    .insert(users)
    .values({ name: cleanName, nameKey, passwordHash: await hashPassword(password) })
    .onConflictDoNothing()
    .returning();
  if (!created) return fail("Este nome acabou de ser registrado. Tente novamente.", 409);
  return startSession(req, created, { created: true });
}

// GET /api/setup — does the site still need its first administrator?
// POST /api/setup — creates that administrator. Requires the ADMIN_SETUP_KEY environment variable,
// so nobody can take the admin account just by visiting the site first.
const setupKey = () => {
  const key = process.env.ADMIN_SETUP_KEY ?? "";
  return key.length >= 16 ? key : null;
};

async function adminCount() {
  const [row] = await db.select({ n: count() }).from(users).where(eq(users.isAdmin, true));
  return row.n;
}

async function setup(req: Request, ip: string) {
  if ((await adminCount()) > 0) return fail("O painel já foi configurado.", 409);
  const key = setupKey();
  if (!key) {
    return fail("Defina a variável ADMIN_SETUP_KEY (mínimo 16 caracteres) no Netlify e publique de novo.", 503);
  }

  const limit = { key: `setup:${ip}`, max: 5 };
  const wait = await blockedFor([limit]);
  if (wait) return tooMany(wait);

  const { setupKey: given, name, password } = await readBody<{ setupKey: string; name: string; password: string }>(req);
  if (!safeEqual(String(given ?? ""), key)) {
    await bump(limit.key, FAIL_WINDOW_MS);
    return fail("Chave de configuração incorreta.", 401);
  }

  const cleanName = (name ?? "").trim();
  if (!NAME_RE.test(cleanName)) return fail("Nome inválido: use 2 a 20 letras, números, '.', '_' ou '-'.");
  const problem = typeof password === "string" ? passwordProblem(password, cleanName, MIN_ADMIN_PASSWORD) : "Digite uma senha.";
  if (problem) return fail(problem);

  const [admin] = await db
    .insert(users)
    .values({ name: cleanName, nameKey: cleanName.toLowerCase(), passwordHash: await hashPassword(password as string), isAdmin: true })
    .onConflictDoNothing()
    .returning();
  if (!admin) return fail("Esse nome já está em uso. Escolha outro para o administrador.", 409);
  await clearLimit(limit.key);
  return startSession(req, admin, { created: true });
}

// POST /api/password — change your own password. Other devices are signed out.
async function changePassword(req: Request) {
  const current = await currentSession(req);
  if (!current) return fail("Faça login para continuar.", 401);
  const { current: oldPassword, next } = await readBody<{ current: string; next: string }>(req);
  if (typeof oldPassword !== "string" || typeof next !== "string") return fail("Informe a senha atual e a nova.");

  const limit = { key: `pw:${current.user.id}`, max: 5 };
  const wait = await blockedFor([limit]);
  if (wait) return tooMany(wait);
  if (!(await verifyPassword(oldPassword, current.user.passwordHash))) {
    await bump(limit.key, FAIL_WINDOW_MS);
    return fail("Senha atual incorreta.", 401);
  }
  const minimum = current.user.isAdmin ? MIN_ADMIN_PASSWORD : MIN_PASSWORD;
  const problem = passwordProblem(next, current.user.name, minimum);
  if (problem) return fail(problem);

  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, current.user.id));
  await db.delete(sessions).where(and(eq(sessions.userId, current.user.id), ne(sessions.id, current.sessionId)));
  await clearLimit(limit.key);
  return json({ ok: true });
}

export default async (req: Request, context: Context) => {
  const path = new URL(req.url).pathname;
  const ip = clientIp(req, context);

  if (path === "/api/login" && req.method === "POST") return login(req, ip);

  if (path === "/api/setup") {
    if (req.method === "GET") return json({ needsSetup: (await adminCount()) === 0, configured: setupKey() !== null });
    if (req.method === "POST") return setup(req, ip);
  }

  if (path === "/api/logout" && req.method === "POST") {
    const { all } = await readBody<{ all: boolean }>(req);
    const current = await currentSession(req);
    if (all && current) await db.delete(sessions).where(eq(sessions.userId, current.user.id));
    else await destroySession(req);
    return json({ ok: true }, 200, { "set-cookie": clearedCookie(req) });
  }

  if (path === "/api/me" && req.method === "GET") {
    const current = await currentSession(req);
    if (!current) return fail("Sessão expirada.", 401, { "set-cookie": clearedCookie(req) });
    // Re-issue the cookie so each visit extends how long the browser keeps it.
    return json({ user: publicUser(current.user) }, 200, { "set-cookie": sessionCookie(req, current.token) });
  }

  if (path === "/api/password" && req.method === "POST") return changePassword(req);

  return fail("Rota não encontrada.", 404);
};

export const config: Config = {
  path: ["/api/login", "/api/logout", "/api/me", "/api/setup", "/api/password"],
};
