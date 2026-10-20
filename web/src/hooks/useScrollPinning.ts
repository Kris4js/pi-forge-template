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
    programmatic.current = false;
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // A smooth scroll fires many events on the way down; ignore them all (not just the first) until
    // it lands, or the jump button would pop back in mid-scroll and flicker.
    if (programmatic.current) {
      if (distance <= 40) programmatic.current = false;
      return;
    }
    pinned.current = distance <= 40;
    // Hysteresis so hovering around the threshold doesn't toggle the button on every frame.
    setShowJump((shown) => distance > 120 || (shown && distance > 40));
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = containerRef.current;
    if (!el) return;
    // Already at the bottom means no scroll event will come to clear the flag.
    programmatic.current = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
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
