import { AnimatePresence, motion } from "framer-motion";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

/**
 * Minimal disclosure primitive with the Radix Collapsible API surface Trace relies on:
 * controlled (`open` + `onOpenChange`) or uncontrolled (`defaultOpen`).
 */
type Ctx = { open: boolean; toggle: () => void; contentId: string };
const CollapsibleContext = createContext<Ctx | null>(null);

function useCollapsible() {
  const ctx = useContext(CollapsibleContext);
  if (!ctx) throw new Error("Collapsible parts must be used inside <Collapsible>");
  return ctx;
}

export type CollapsibleProps = HTMLAttributes<HTMLDivElement> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function Collapsible({ open: openProp, defaultOpen = false, onOpenChange, children, ...props }: CollapsibleProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const contentId = useId();
  const toggle = useCallback(() => {
    const next = !open;
    if (openProp === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  }, [open, openProp, onOpenChange]);

  return (
    <CollapsibleContext.Provider value={{ open, toggle, contentId }}>
      <div data-state={open ? "open" : "closed"} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({ onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, toggle, contentId } = useCollapsible();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      data-state={open ? "open" : "closed"}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) toggle();
      }}
      {...props}
    />
  );
}

export function CollapsibleContent({ className, children }: { className?: string; children?: ReactNode }) {
  const { open, contentId } = useCollapsible();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={contentId}
          className={className}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
