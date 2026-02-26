import { supabase } from "./db";

export interface SystemEventInput {
  level: "info" | "warn" | "error" | "critical";
  component: "relay" | "jobs" | "processor" | "heartbeat" | "ingest" | "system";
  eventType: string;
  message: string;
  runId?: string;
  relatedBlockId?: string;
  relatedArtifactId?: string;
  payload?: Record<string, unknown>;
}

export async function logSystemEvent(input: SystemEventInput): Promise<void> {
  await supabase.from("system_events").insert({
    level: input.level,
    component: input.component,
    event_type: input.eventType,
    message: input.message,
    run_id: input.runId ?? null,
    related_block_id: input.relatedBlockId ?? null,
    related_artifact_id: input.relatedArtifactId ?? null,
    payload: input.payload ?? {},
  });
}
