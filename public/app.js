import { api, el, fmtTime, session } from "/api.js";

const $ = (id) => document.getElementById(id);
const views = ["construction", "login", "chat"];
const POLL_MS = 2000;

let me = null;
let config = null;
let lastId = 0;
let pollTimer = null;
let online = [];

function show(view) {
  for (const v of views) $(`view-${v}`).hidden = v !== view;
}

// Same name always gets the same shade of green/cyan.
const PALETTE = ["#39ff88", "#7dffb2", "#b4ff39", "#39ffd5", "#9cff6b", "#5ce1ff", "#d4ff8a", "#00e676"];
function colorFor(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ---------- Output ---------- */
const output = () => $("output");

function atBottom() {
  const o = output();
  return o.scrollHeight - o.scrollTop - o.clientHeight < 40;
}

function append(node) {
  const stick = atBottom();
  output().append(node);
  if (stick) output().scrollTop = output().scrollHeight;
}

function info(text, cls = "info") {
  append(el("div", { class: `line ${cls}` }, text));
}

function renderMessage(m) {
  if (m.kind === "system") {
    append(el("div", { class: "line sys" }, el("span", { class: "time" }, `[${fmtTime(m.createdAt)}] `), `*** AVISO: ${m.body}`));
    return;
  }
  const name = m.name ?? "desconhecido";
  const mine = me && name.toLowerCase() === me.name.toLowerCase();
  append(
    el(
      "div",
      { class: `line${mine ? " me" : ""}` },
      el("span", { class: "time" }, `[${fmtTime(m.createdAt)}] `),
      el("span", { class: "who", style: `color:${colorFor(name)}` }, name),
      m.isAdmin ? el("span", { class: "badge" }, " [admin]") : null,
      el("span", { class: "muted" }, " > "),
      m.body,
    ),
  );
}

/* ---------- Polling ---------- */
async function poll() {
  clearTimeout(pollTimer);
  try {
    const data = await api(`/api/messages?after=${lastId}`);
    for (const m of data.messages) {
      renderMessage(m);
      lastId = Math.max(lastId, m.id);
    }
    online = data.online;
    $("online-count").textContent = `${online.length} online`;
  } catch (err) {
    if (err.status === 401 || err.status === 503) return kickToStart(err.message);
  }
  pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && me) poll();
});

/* ---------- Commands ---------- */
const COMMANDS = {
  ajuda() {
    info("comandos disponíveis:");
    info("  /ajuda    mostra esta lista");
    info("  /quem     lista quem está online");
    info("  /limpar   limpa a tela");
    info("  /sair     encerra a sessão");
    if (me?.isAdmin) info("  /admin    abre o painel de administração");
  },
  quem() {
    info(online.length ? `online agora (${online.length}): ${online.join(", ")}` : "ninguém online além de você.");
  },
  limpar() {
    output().replaceChildren();
  },
  sair() {
    logout();
  },
  admin() {
    if (me?.isAdmin) location.href = "/admin";
    else info("comando restrito ao administrador.", "err");
  },
};
COMMANDS.help = COMMANDS.ajuda;
COMMANDS.who = COMMANDS.quem;
COMMANDS.clear = COMMANDS.limpar;
COMMANDS.exit = COMMANDS.sair;

async function onSubmitChat(e) {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  if (text.startsWith("/")) {
    const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
    info(`$ ${text}`, "muted");
    (COMMANDS[cmd] ?? (() => info(`comando não encontrado: /${cmd} — digite /ajuda`, "err")))();
    return;
  }

  try {
    await api("/api/messages", { method: "POST", body: { body: text } });
    poll();
  } catch (err) {
    info(`erro: ${err.message}`, "err");
    if (err.status === 401 || err.status === 503) kickToStart(err.message);
  }
}

/* ---------- Session flow ---------- */
function enterChat() {
  show("chat");
  document.title = config.title;
  $("chat-title").textContent = config.title;
  $("prompt-name").textContent = me.name;
  $("who-am-i").textContent = me.isAdmin ? `${me.name} [admin]` : me.name;
  output().replaceChildren();
  lastId = 0;
  info(`${config.title} — sessão iniciada como ${me.name}`, "glow");
  if (config.construction && me.isAdmin) info("modo em construção ATIVO: só administradores veem o chat.", "warn");
  if (config.motd) info(config.motd);
  info("—".repeat(24));
  poll();
  $("chat-input").focus();
}

function showLogin(message = "") {
  show("login");
  document.title = config.title;
  $("login-title").textContent = config.title;
  $("login-msg").textContent = message;
  $("login-msg").className = `form-msg${message ? " err" : ""}`;
}

function showConstruction() {
  show("construction");
  document.title = "Meu site";
  $("construction-text").textContent = config.constructionText || "Em construção.";
}

function kickToStart(message) {
  clearTimeout(pollTimer);
  me = null;
  session.clear();
  if (config.construction) showConstruction();
  else showLogin(message);
}

async function logout() {
  clearTimeout(pollTimer);
  await api("/api/logout", { method: "POST" }).catch(() => {});
  me = null;
  session.clear();
  if (config.construction) showConstruction();
  else showLogin();
}

async function onSubmitLogin(e) {
  e.preventDefault();
  const btn = e.submitter ?? e.target.querySelector("button");
  const msg = $("login-msg");
  btn.disabled = true;
  msg.className = "form-msg muted";
  msg.textContent = "autenticando...";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: { name: $("login-name").value, password: $("login-pass").value },
    });
    session.set(data.token);
    me = data.user;
    $("login-pass").value = "";
    enterChat();
    if (data.created) info(`o nome "${me.name}" agora é seu. guarde a senha — ela é a única chave dele.`, "warn");
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = `erro: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function boot() {
  $("login-form").addEventListener("submit", onSubmitLogin);
  $("chat-form").addEventListener("submit", onSubmitChat);
  $("logout-btn").addEventListener("click", logout);

  try {
    config = await api("/api/config");
  } catch {
    config = { construction: true, motd: "", constructionText: "Em construção." };
  }
  config.title ||= "TERMINAL//CHAT";

  if (session.token) {
    try {
      me = (await api("/api/me")).user;
    } catch {
      session.clear();
    }
  }

  if (me && (!config.construction || me.isAdmin)) return enterChat();
  if (config.construction) return showConstruction();
  showLogin();
}

boot();
