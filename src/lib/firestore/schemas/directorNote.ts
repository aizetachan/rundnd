import { z } from "zod";

export const DirectorNoteScope = z.enum(["turn", "session", "arc", "campaign"]);
export type DirectorNoteScope = z.infer<typeof DirectorNoteScope>;

/**
 * `campaigns/{campaignId}/directorNotes/{noteId}` — advisory guidance
 * KA reads in Block 4 director_notes.
 */
export const FirestoreDirectorNote = z.object({
  id: z.string(),
  campaignId: z.string(),
  content: z.string(),
  scope: DirectorNoteScope.default("session"),
  createdAtTurn: z.number().int().nonnegative(),
  createdAt: z.date(),
});
export type FirestoreDirectorNote = z.infer<typeof FirestoreDirectorNote>;
