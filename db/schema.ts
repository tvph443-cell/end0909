import { pgTable, serial, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

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

export const sessions = pgTable("sessions", {
  token: text().primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: serial().primaryKey(),
    // Null for system announcements posted from the admin panel.
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    body: text().notNull(),
    kind: text().notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_created_at_idx").on(t.createdAt)],
);

// Key/value site settings editable from the admin panel.
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});
