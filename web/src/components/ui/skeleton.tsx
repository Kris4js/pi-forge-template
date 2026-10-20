/*
 * Skeleton — ported from shadcn/ui (apps/v4/registry/bases/base/ui/skeleton.tsx); styles in ai-elements.css.
 * Copyright (c) 2023 shadcn — MIT License.
 */
import type { ComponentProps } from "react";

function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={["skeleton-block", className].filter(Boolean).join(" ")} {...props} />;
}

export { Skeleton };
