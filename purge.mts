import type { Config } from "@netlify/functions";
import { purgeExpired } from "../lib/core.js";

// Hourly housekeeping. Expired messages are already hidden from the chat the instant their day ends
// (see `expires_at`), so this only frees space — it never decides what people can see.
// Messages somebody starred are kept; they stay in that person's saved list.
export default async () => {
  const result = await purgeExpired();
  console.log(`purge: ${result.messages} expired message(s) removed`);
};

export const config: Config = {
  schedule: "0 * * * *",
};
