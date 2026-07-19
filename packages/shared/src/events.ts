import { z } from "zod";
import { ActionEventSchema, CoordinatesSchema, GameStateSchema, RoomSettingsSchema } from "./domain.js";
import { PlayAreaAssessmentSchema } from "./play-area-assessment.js";

export const PlayAreaRadiusInfoSchema = z.object({
  minM: z.number().positive(),
  maxM: z.number().positive(),
  stepM: z.number().positive(),
  defaultM: z.number().positive(),
  currentM: z.number().positive(),
  isAuto: z.boolean(),
  presets: z.object({
    tightM: z.number().positive(),
    balancedM: z.number().positive(),
    recommendedM: z.number().positive(),
    hideSeekM: z.number().positive(),
    microM: z.number().positive()
  }),
  rallyHitM: z.number().positive()
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_room"), roomId: z.string(), playerId: z.string(), name: z.string(), settings: RoomSettingsSchema.partial() }),
  z.object({ type: z.literal("join_room"), roomId: z.string(), playerId: z.string(), name: z.string() }),
  z.object({ type: z.literal("set_ready"), roomId: z.string(), playerId: z.string(), ready: z.boolean() }),
  z.object({ type: z.literal("select_fugitive"), roomId: z.string(), by: z.string(), fugitiveId: z.string() }),
  z.object({ type: z.literal("start_game"), roomId: z.string(), by: z.string() }),
  z.object({ type: z.literal("start_chase"), roomId: z.string(), by: z.string(), force: z.boolean().optional() }),
  z.object({ type: z.literal("use_cop_scan"), roomId: z.string(), by: z.string() }),
  z.object({ type: z.literal("use_decoy_reveal"), roomId: z.string(), by: z.string() }),
  z.object({ type: z.literal("cop_noise_ping"), roomId: z.string(), by: z.string() }),
  z.object({ type: z.literal("attempt_arrest"), roomId: z.string(), by: z.string() }),
  z.object({ type: z.literal("start_mission_hold"), roomId: z.string(), by: z.string(), missionId: z.string() }),
  z.object({ type: z.literal("cancel_mission_hold"), roomId: z.string(), by: z.string(), missionId: z.string() }),
  z.object({ type: z.literal("complete_mission_hold"), roomId: z.string(), by: z.string(), missionId: z.string(), devShortHold: z.boolean().optional() }),
  z.object({ type: z.literal("location_update"), roomId: z.string(), playerId: z.string(), location: CoordinatesSchema, simulated: z.boolean().optional() }),
  z.object({ type: z.literal("dev_trigger_reveal"), roomId: z.string(), by: z.string() }),
  z.object({ type: z.literal("set_play_area_radius"), roomId: z.string(), by: z.string(), radiusM: z.number().positive().nullable() }),
  z.object({ type: z.literal("trigger_action"), payload: ActionEventSchema }),
  z.object({ type: z.literal("heartbeat"), roomId: z.string(), playerId: z.string() })
]);

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state_sync"),
    state: GameStateSchema,
    startEligibility: z.object({ ok: z.boolean(), reason: z.string() }),
    playAreaAssessment: PlayAreaAssessmentSchema.nullable().optional(),
    playAreaRadius: PlayAreaRadiusInfoSchema.optional()
  }),
  z.object({ type: z.literal("reveal_positions"), positions: z.array(CoordinatesSchema) }),
  z.object({ type: z.literal("sound_event"), sound: z.string(), reason: z.string() }),
  z.object({ type: z.literal("action_event"), message: z.string() }),
  z.object({ type: z.literal("mission_completed"), missionName: z.string(), completedCount: z.number().int().nonnegative(), totalCount: z.number().int().positive() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("session"), reconnectToken: z.string() })
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
