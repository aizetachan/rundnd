import { z } from "zod";

/**
 * `profiles/{profileId}` — canonical IP data (Cowboy Bebop, Solo Leveling, etc).
 *
 * Top-level because profiles are shared across users (same Cowboy Bebop
 * profile backs every player's Bebop campaign). The `slug` is the
 * stable lookup key (e.g. `cowboy-bebop`); `id` is autogen.
 *
 * The full Zod-typed Profile object lives in `src/lib/types/profile.ts`
 * and is what `content` is validated against on read. Storing it as
 * `unknown` here lets the surface type stay clean while the consumer
 * does the deep parse with the real Profile schema.
 */
export const FirestoreProfile = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  mediaType: z.string(),
  content: z.unknown(),
  version: z.number().int().positive(),
  createdAt: z.date(),
});
export type FirestoreProfile = z.infer<typeof FirestoreProfile>;
