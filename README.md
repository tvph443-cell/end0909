# TERMINAL//CHAT

Chat em tempo real com visual de prompt de comando: fundo escuro, detalhes em verde e mensagens no formato `[hh:mm] nome > texto`.

## Como funciona

- **Login por reivindicação**: nome **novo** é registrado com a senha digitada (mínimo 6 caracteres); nome **já usado** só entra com a senha correta. Nomes como `admin`, `root` e `sistema` são reservados.
- **Você continua conectado** neste aparelho até clicar em **sair** (ou digitar `/sair`). `/sair tudo` desconecta todos os aparelhos.
- **Chat** estilo terminal. Comandos: `/ajuda`, `/quem`, `/salvas`, `/senha atual nova`, `/limpar`, `/sair [tudo]` (e `/admin` para administradores).
- **Mensagens salvas (★)**: o botão ☆ ao lado de cada mensagem guarda uma cópia só para você, na lista **★ salvas**.
- **Validade das mensagens**: mensagens normais duram **30 dias** e avisos do sistema **365 dias**. O dia de envio conta como dia 1 e cada dia termina às **00:00** (fuso `America/Sao_Paulo`, mude com `CHAT_TIMEZONE`). Quando vencem, saem do chat para todos; as que alguém salvou continuam na lista de salvas dessa pessoa.
- **Painel de administração** em `/admin`, com cards e um **terminal exclusivo do admin** (`ajuda`, `stats`, `usuarios`, `aviso`, `bloquear`, `desbloquear`, `promover`, `rebaixar`, `deslogar`, `apagar`, `limpar-chat`, `limpeza`, `construcao on|off`).
  - modo **Em construção** (ligado por padrão), textos do site, avisos, gestão de nomes e mensagens.

### Primeiro acesso ao painel (obrigatório configurar uma vez)

O administrador **não** é mais o primeiro a registrar `admin`. Para criá-lo:

1. No Netlify: **Site configuration → Environment variables** → crie `ADMIN_SETUP_KEY` com um texto secreto de **16+ caracteres**.
2. Publique de novo (deploy) para a variável valer.
3. Abra `/admin`, informe a chave, escolha login e senha (10+ caracteres). Depois disso a tela de configuração some.

Dá para apagar `ADMIN_SETUP_KEY` depois; ela só é usada enquanto não existe administrador.

## Segurança

- Sessão em cookie `HttpOnly` + `SameSite=Lax` (o JavaScript da página não enxerga o token); o banco guarda só o hash (SHA-256) do token. Até 10 aparelhos por pessoa.
- Limite de tentativas: 5 senhas erradas por nome+origem e 20 por origem a cada 15 min; 5 novos nomes por hora por origem; limite de flood no chat.
- Cabeçalhos de segurança e CSP em `netlify.toml`.
- Senhas com `scrypt`.

## Tecnologias

- HTML, CSS e JavaScript puros em `public/`
- Netlify Functions (TypeScript) em `netlify/functions/` (inclui `purge.mts`, limpeza agendada de hora em hora)
- Netlify Database (Postgres) + Drizzle ORM — esquema em `db/schema.ts`
- Versões das dependências **fixas** (Drizzle está em beta); atualize de propósito, não por acidente.

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha ADMIN_SETUP_KEY
npx netlify dev
npm run typecheck
```

Após alterar `db/schema.ts`: `npx drizzle-kit generate --name descreva_a_mudanca`. As migrações em `netlify/database/migrations/` são aplicadas pela Netlify no deploy.
