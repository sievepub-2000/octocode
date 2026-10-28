import { z } from "zod/v4"

export const checkpointSchema = z.object({
	from: z.string(),
	to: z.string(),
})

export type Checkpoint = z.infer<typeof checkpointSchema>
