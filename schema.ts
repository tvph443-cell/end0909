import { pgTable, serial, text, timestamp, integer, boolean, index, primaryKey } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  // Lowercased name used for uniqueness — "Ana" and "ana" are the same person.
  nameKey: text("name_key").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  banned: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per logged-in device. The cookie holds the raw token; only its SHA-256 is stored here,
// so a leaked database can't be replayed as live sessions. Rows live until logout (see core.ts).
export const sessions = pgTable(
  "sessions",
  {
    id: serial().primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: serial().primaryKey(),
    // Null for system announcements posted from the admin panel.
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    body: text().notNull(),
    kind: text().notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Moment the message leaves the shared chat (always a local 00:00, see netlify/lib/time.ts).
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("messages_created_at_idx").on(t.createdAt),
    index("messages_expires_at_idx").on(t.expiresAt),
  ],
);

// Personal "starred" messages. A starred message is kept after it expires from the shared chat,
// and is only visible to the people who starred it.
export const messageStars = pgTable(
  "message_stars",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.messageId] }), index("message_stars_message_id_idx").on(t.messageId)],
);

// Fixed-window counters for login / signup / flood limits.
export const rateLimits = pgTable("rate_limits", {
  key: text().primaryKey(),
  count: integer().notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

// Key/value site settings editable from the admin panel.
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});
