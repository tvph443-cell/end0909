import { api, el, fmtDate, session } from "/api.js";

const $ = (id) => document.getElementById(id);
let me = null;

function toast(text) {
  const t = el("div", { class: "toast", role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function run(action, okText) {
  try {
    await action();
    if (okText) toast(okText);
  } catch (err) {
    if (err.status === 401 || err.status === 403) return showLogin(err.message);
    toast(`erro: ${err.message}`);
  }
}

function showLogin(message = "") {
  me = null;
  session.clear();
  $("view-panel").hidden = true;
  $("view-login").hidden = false;
  $("login-msg").className = "form-msg err";
  $("login-msg").textContent = message;
}

function renderConstruction(on) {
  $("construction-toggle").checked = on;
  $("construction-label").textContent = on ? "Em construção (ATIVO)" : "Chat aberto ao público";
  $("construction-hint").textContent = on
    ? "Visitantes veem só a página em construção. Administradores continuam acessando o chat."
    : "Qualquer pessoa pode escolher um nome e entrar no chat.";
}

async function loadSettings() {
  const s = await api("/api/admin/settings");
  renderConstruction(s.construction === "true");
  $("set-title").value = s.title;
  $("set-motd").value = s.motd;
  $("set-construction").value = s.constructionText;
}

async function loadStats() {
  const s = await api("/api/admin/stats");
  $("stat-users").textContent = s.users;
  $("stat-messages").textContent = s.messages;
}

async function loadUsers() {
  const { users } = await api("/api/admin/users");
  $("users-body").replaceChildren(
    ...users.map((u) => {
      const self = u.id === me.id;
      const patch = (body, ok) => run(async () => { await api(`/api/admin/users/${u.id}`, { method: "PATCH", body }); await loadUsers(); }, ok);
      return el(
        "tr",
        {},
        el(
          "td",
          {},
          el("span", { class: u.banned ? "muted" : "glow" }, u.name),
          u.isAdmin ? el("span", { class: "tag warn" }, "admin") : null,
          u.banned ? el("span", { class: "tag err" }, "bloqueado") : null,
        ),
        el("td", { class: "muted" }, u.messageCount),
        el("td", { class: "muted" }, fmtDate(u.lastSeenAt)),
        el(
          "td",
          { class: "actions-cell" },
          self
            ? el("span", { class: "muted" }, "você")
            : [
                el("button", { class: "btn ghost small", type: "button", onclick: () => patch({ isAdmin: !u.isAdmin }, "permissão atualizada") }, u.isAdmin ? "tirar admin" : "tornar admin"),
                el("button", { class: "btn ghost small", type: "button", onclick: () => patch({ banned: !u.banned }, u.banned ? "nome desbloqueado" : "nome bloqueado") }, u.banned ? "desbloquear" : "bloquear"),
                el("button", {
                  class: "btn danger small",
                  type: "button",
                  onclick: () => {
                    if (!confirm(`Apagar "${u.name}"? O nome fica livre e as mensagens dele somem.`)) return;
                    run(async () => { await api(`/api/admin/users/${u.id}`, { method: "DELETE" }); await Promise.all([loadUsers(), loadMessages(), loadStats()]); }, "nome apagado");
                  },
                }, "apagar"),
              ],
        ),
      );
    }),
  );
}

async function loadMessages() {
  const { messages } = await api("/api/admin/messages");
  const list = $("messages-list");
  if (!messages.length) return list.replaceChildren(el("p", { class: "muted" }, "nenhuma mensagem ainda."));
  list.replaceChildren(
    ...messages.map((m) =>
      el(
        "div",
        { class: "msg-item" },
        el("span", { class: "muted" }, fmtDate(m.createdAt)),
        el("span", { class: m.kind === "system" ? "warn" : "glow" }, m.kind === "system" ? "AVISO" : m.name),
        el("span", { class: "text" }, m.body),
        el("button", {
          class: "btn danger small",
          type: "button",
          onclick: () => run(async () => { await api(`/api/admin/messages/${m.id}`, { method: "DELETE" }); await Promise.all([loadMessages(), loadStats()]); }, "mensagem apagada"),
        }, "apagar"),
      ),
    ),
  );
}

async function enterPanel() {
  $("view-login").hidden = true;
  $("view-panel").hidden = false;
  $("admin-name").textContent = `logado como ${me.name}`;
  await run(() => Promise.all([loadSettings(), loadStats(), loadUsers(), loadMessages()]));
}

async function boot() {
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("login-msg");
    msg.className = "form-msg muted";
    msg.textContent = "autenticando...";
    try {
      const data = await api("/api/login", { method: "POST", body: { name: $("login-name").value, password: $("login-pass").value } });
      if (!data.user.isAdmin) {
        session.set(data.token);
        await api("/api/logout", { method: "POST" }).catch(() => {});
        return showLogin("este nome não tem acesso de administrador.");
      }
      session.set(data.token);
      me = data.user;
      $("login-pass").value = "";
      enterPanel();
    } catch (err) {
      msg.className = "form-msg err";
      msg.textContent = `erro: ${err.message}`;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    showLogin();
  });

  $("construction-toggle").addEventListener("change", (e) =>
    run(async () => {
      const s = await api("/api/admin/settings", { method: "PUT", body: { construction: e.target.checked } });
      renderConstruction(s.construction === "true");
    }, e.target.checked ? "site em construção" : "chat aberto ao público"),
  );

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(() => api("/api/admin/settings", {
      method: "PUT",
      body: { title: $("set-title").value.trim(), motd: $("set-motd").value.trim(), constructionText: $("set-construction").value.trim() },
    }), "textos salvos");
  });

  $("announce-form").addEventListener("submit", (e) => {
    e.preventDefault();
    run(async () => {
      await api("/api/admin/messages", { method: "POST", body: { body: $("announce-body").value } });
      $("announce-body").value = "";
      await Promise.all([loadMessages(), loadStats()]);
    }, "aviso publicado");
  });

  $("clear-messages").addEventListener("click", () => {
    if (!confirm("Apagar TODAS as mensagens do chat?")) return;
    run(async () => { await api("/api/admin/messages", { method: "DELETE" }); await Promise.all([loadMessages(), loadStats()]); }, "chat limpo");
  });

  if (session.token) {
    try {
      me = (await api("/api/me")).user;
    } catch {
      session.clear();
    }
  }
  if (me?.isAdmin) enterPanel();
  else showLogin();
}

boot();
