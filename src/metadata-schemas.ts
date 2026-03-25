import { z } from "zod";

export const BaseMeta = z.object({}).passthrough();

export const ActionOpenMeta = BaseMeta.extend({
  action_type: z.string().optional(),
  last_acknowledged_at: z.string().datetime().optional(),
  surface_interval_days: z.number().optional(),
  next_surface_at: z.string().datetime().optional(),
});

export const ActionClosedMeta = BaseMeta.extend({
  closed_reason: z.enum(["done", "archived"]).optional(),
  closed_at: z.string().datetime().optional(),
});

export const ReviewSourceMeta = BaseMeta.extend({
  source: z.enum(["state_processor", "hourly_review", "daily_review", "weekly_review"]).optional(),
  type: z.string().optional(),
});

export const MergeCandidateMeta = ReviewSourceMeta.extend({
  type: z.literal("merge_candidate"),
  entity_id_keep: z.string().uuid(),
  entity_id_merge: z.string().uuid(),
  reason: z.string(),
  review_status: z.enum(["pending", "resolved", "rejected"]).optional(),
  reviewed_at: z.string().datetime().optional(),
});

export type ActionClosedReason = z.infer<typeof ActionClosedMeta>["closed_reason"];
