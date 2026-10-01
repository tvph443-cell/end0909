# TERMINAL//CHAT

Chat em tempo real com visual de prompt de comando: fundo escuro, detalhes em verde e mensagens no formato `[hh:mm] nome > texto`.

## Como funciona

- **Tela de inscrição** com `login` e `senha`.
  - Nome **novo** → é registrado com qualquer senha digitada; daí em diante o nome fica ligado a essa senha.
  - Nome **já usado** → só entra com a senha correta.
- **Chat** estilo terminal, com comandos `/ajuda`, `/quem`, `/limpar`, `/sair` (e `/admin` para administradores).
- **Painel de administração** em `/admin` para atualizar o site sem mexer no código:
  - ligar/desligar o modo **Em construção** (vem ligado por padrão);
  - editar o nome do chat, a mensagem de boas-vindas e o texto da página em construção;
  - publicar avisos para todos no chat;
  - ver, bloquear, promover a admin ou apagar nomes (apagar libera o nome);
  - apagar mensagens individuais ou limpar o chat.

### Primeiro acesso ao painel

Abra `/admin` logo após publicar e entre como **`admin`** com a senha que quiser — o primeiro registro do nome `admin` vira o administrador do site.

## Tecnologias

- HTML, CSS e JavaScript puros (sem framework) em `public/`
- Netlify Functions (TypeScript) para a API em `netlify/functions/`
- Netlify Database (Postgres) com Drizzle ORM — esquema em `db/schema.ts`
- Senhas protegidas com `scrypt`; sessões por token

## Rodando localmente

```bash
npm install
npx netlify dev
```

Após alterar `db/schema.ts`, gere uma migração:

```bash
npx drizzle-kit generate --name descreva_a_mudanca
```

As migrações em `netlify/database/migrations/` são aplicadas automaticamente pela Netlify no deploy.
