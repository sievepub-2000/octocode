import type { ComponentPropsWithoutRef, ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Checkbox as CheckboxControl } from "./checkbox"

type CheckboxProps = Omit<
	ComponentPropsWithoutRef<typeof CheckboxControl>,
	"checked" | "children" | "className" | "onCheckedChange" | "onChange"
> & {
	checked?: boolean
	children?: ReactNode
	className?: string
	onChange: (checked: boolean) => void
}

export const Checkbox = ({ checked, children, className, onChange, ...props }: CheckboxProps) => (
	<label className={cn("flex cursor-pointer items-center gap-2", className)}>
		<CheckboxControl checked={checked} onCheckedChange={(value) => onChange(value === true)} {...props} />
		<span>{children}</span>
	</label>
)
