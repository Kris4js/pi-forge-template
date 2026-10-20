import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps the transcript pinned to the bottom while tokens stream in, but lets go as soon as the
 * user scrolls (wheel / touch / keys), with a short cool-down so streaming never fights the user.
 * Pattern from open-claude-ui's useClaudeScrollPinning (MIT).
 */
export function useScrollPinning(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastUserInput = useRef(0);
  const programmatic = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const markUserInput = useCallback(() => {
    lastUserInput.current = performance.now();
    pinned.current = false;
  }, []);

  const onScroll = useCallback(() => {
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distance <= 40;
    setShowJump(distance > 120);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = containerRef.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    pinned.current = true;
    setShowJump(false);
  }, []);

  useEffect(() => {
    if (performance.now() - lastUserInput.current <= 150) return;
    if (pinned.current) scrollToBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, onScroll, markUserInput, scrollToBottom, showJump };
}
