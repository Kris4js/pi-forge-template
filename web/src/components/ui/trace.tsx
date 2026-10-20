/*
 * Trace — the steps an agent takes (reasoning, tool calls, sources, subagents) as one list of lines.
 * Ported from shadcn/ui (apps/v4/registry/bases/radix/ui/trace.tsx) with the same parts and
 * data-slot structure; styling lives in ai-elements.css instead of Tailwind.
 * Copyright (c) 2023 shadcn — MIT License.
 */
import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, type CollapsibleProps } from "./collapsible";

const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/** "approval" is a pi-forge addition: the step is parked until a human decides. */
export type TraceStatus = "running" | "error" | "pending" | "approval";

export function Trace({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="trace" className={cx("trace", className)} {...props} />;
}

export function TraceLine({ className, status, ...props }: ComponentProps<"span"> & { status?: TraceStatus }) {
  return <span data-slot="trace-line" data-status={status} className={cx("trace-line", className)} {...props} />;
}

export function TraceIcon({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-icon" aria-hidden="true" className={cx("trace-icon", className)} {...props} />;
}

export function TraceTitle({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cx("trace-title", className)} {...props} />;
}

export function TraceDescription({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-description" className={cx("trace-description", className)} {...props} />;
}

export function TraceCollapsible({ className, ...props }: CollapsibleProps) {
  return <Collapsible data-slot="trace-collapsible" className={cx("trace-collapsible", className)} {...props} />;
}

export function TraceCollapsibleTrigger({ className, children, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger data-slot="trace-collapsible-trigger" className={cx("trace-collapsible-trigger", className)} {...props}>
      {children}
      <TraceIcon className="trace-chevron">
        <ChevronRight />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

export function TraceCollapsibleContent({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <CollapsibleContent className="trace-collapsible-content">
      <div data-slot="trace-collapsible-content-inner" className={cx("trace-collapsible-content-inner", className)}>
        {children}
      </div>
    </CollapsibleContent>
  );
}
