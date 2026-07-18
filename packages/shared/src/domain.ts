import { z } from "zod";

export const RoleSchema = z.enum(["hunter", "runner", "support", "organizer"]);
export type Role = z.infer<typeof RoleSchema>;

export const CoordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().positive().max(500),
  ts: z.number().int().positive()
});
export type Coordinates = z.infer<typeof CoordinatesSchema>;

export const ActionTypeSchema = z.enum(["sonar_ping", "jam", "fake_clue"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const FugitiveSelectionSchema = z.enum(["random", "manual"]);

export const RoomSettingsSchema = z.object({
  roomName: z.string().min(1),
  durationSec: z.number().int().positive(),
  maxPlayers: z.number().int().min(2).max(30),
  minPlayersToStart: z.number().int().min(2).default(6),
  boundaryPreset: z.enum(["district_small", "district_medium", "district_large"]),
  fugitiveSelection: FugitiveSelectionSchema.default("random"),
  actionToggles: z.record(ActionTypeSchema, z.boolean())
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

export const PlayerSchema = z.object({
  id: z.string().min(3),
  name: z.string().min(1),
  role: RoleSchema,
  connected: z.boolean().default(true),
  ready: z.boolean().default(false),
  reachedRally: z.boolean().default(false),
  usedNoisePing: z.boolean().default(false),
  usedDecoyPower: z.boolean().default(false),
  arrestAttemptsUsed: z.number().int().nonnegative().max(2).default(0),
  lastLocation: CoordinatesSchema.nullable().default(null),
  cooldowns: z.record(ActionTypeSchema, z.number().int().nonnegative()).default({
    sonar_ping: 0,
    jam: 0,
    fake_clue: 0
  })
});
export type Player = z.infer<typeof PlayerSchema>;

export const GamePhaseSchema = z.enum(["lobby", "rally", "active", "finished"]);
export type GamePhase = z.infer<typeof GamePhaseSchema>;

export const MissionSchema = z.object({
  id: z.string(),
  point: CoordinatesSchema,
  completed: z.boolean(),
  holdStartTick: z.number().int().nonnegative().nullable()
});
export type Mission = z.infer<typeof MissionSchema>;

export const GameStateSchema = z.object({
  roomId: z.string().min(3),
  phase: GamePhaseSchema,
  tick: z.number().int().nonnegative(),
  durationSec: z.number().int().positive(),
  settings: RoomSettingsSchema,
  players: z.record(z.string(), PlayerSchema),
  fugitiveId: z.string().nullable(),
  rallyPoints: z.record(z.string(), CoordinatesSchema),
  missions: z.array(MissionSchema),
  revealUntilTick: z.number().int().nonnegative(),
  nextRevealTick: z.number().int().nonnegative(),
  decoyNextReveal: z.boolean().default(false),
  winner: z.enum(["cops", "fugitive"]).nullable().default(null),
  debriefPoint: CoordinatesSchema.nullable().default(null),
  eventLog: z.array(z.string())
});
export type GameState = z.infer<typeof GameStateSchema>;

export const ActionEventSchema = z.object({
  roomId: z.string(),
  actorId: z.string(),
  action: ActionTypeSchema,
  ts: z.number().int().positive()
});
export type ActionEvent = z.infer<typeof ActionEventSchema>;

export const DEFAULT_COOLDOWN_SEC: Record<ActionType, number> = {
  sonar_ping: 30,
  jam: 60,
  fake_clue: 45
};

export const DEFAULT_SETTINGS: RoomSettings = {
  roomName: "City Chase",
  durationSec: 3600,
  maxPlayers: 12,
  minPlayersToStart: 6,
  boundaryPreset: "district_medium",
  fugitiveSelection: "random",
  actionToggles: {
    sonar_ping: true,
    jam: true,
    fake_clue: true
  }
};
