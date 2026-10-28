import { z } from "zod/v4"

import type { Keys, Equals, AssertEqual } from "./type-fu.js"

/**
 * ExperimentId
 */

export const experimentIds = [
	"preventFocusDisruption",
	"runSlashCommand",
	"customTools",
	"parallelToolExecution",
] as const

export const experimentIdsSchema = z.enum(experimentIds)

export type ExperimentId = z.infer<typeof experimentIdsSchema>

/**
 * Experiments
 */

export const experimentsSchema = z.object({
	preventFocusDisruption: z.boolean().optional(),
	runSlashCommand: z.boolean().optional(),
	customTools: z.boolean().optional(),
	parallelToolExecution: z.boolean().optional(),
})

export type Experiments = z.infer<typeof experimentsSchema>

type _AssertExperiments = AssertEqual<Equals<ExperimentId, Keys<Experiments>>>
