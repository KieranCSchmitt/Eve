import { z } from "zod";
export const systemActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("volume"),
      percent: z.number().finite().min(0).max(100),
    })
    .strict(),
  z.object({ type: z.literal("mute"), muted: z.boolean() }).strict(),
  z.object({ type: z.literal("connect"), uuid: z.string().uuid() }).strict(),
  z.object({ type: z.literal("lock") }).strict(),
  z
    .object({
      type: z.literal("settings"),
      panel: z.enum(["sound", "network", "bluetooth", "display"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("exit"),
      action: z.enum(["logout", "restart", "shutdown"]),
    })
    .strict(),
]);
export const networkConnectionSchema = z.object({
  uuid: z.string().max(128),
  name: z.string().max(1000),
  type: z.string().max(100),
  device: z.string().max(300).nullable(),
});
export const systemStatusSchema = z.object({
  available: z.boolean(),
  session: z.boolean(),
  audio: z.object({
    available: z.boolean(),
    volume: z.number().finite().optional(),
    muted: z.boolean().optional(),
  }),
  network: z.object({
    available: z.boolean(),
    active: z.array(networkConnectionSchema).max(1000),
  }),
});
