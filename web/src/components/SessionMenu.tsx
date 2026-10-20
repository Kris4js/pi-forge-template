import { Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Item = { key: string; label: string; icon: ReactNode; danger?: boolean; onSelect: () => void };

/**
 * Row menu for a session (pin / rename / delete). Rendered in a portal with fixed positioning so the
 * scrolling history list cannot clip it. The letter shortcuts work while it is open.
 */
export function SessionMenu({
  anchor,
  pinned,
  onPin,
  onRename,
  onDelete,
  onClose,
}: {
  anchor: HTMLElement;
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  const items: Item[] = [
    { key: "P", label: pinned ? "取消置顶" : "置顶", icon: pinned ? <PinOff size={16} /> : <Pin size={16} />, onSelect: onPin },
    { key: "R", label: "重命名", icon: <Pencil size={16} />, onSelect: onRename },
    { key: "D", label: "删除", icon: <Trash2 size={16} />, danger: true, onSelect: onDelete },
  ];

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 150;
    const width = menu.current?.offsetWidth ?? 180;
    const below = rect.bottom + 6 + height <= window.innerHeight - 8;
    setPosition({
      top: below ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
      left: Math.min(Math.max(8, rect.right - width + 8), window.innerWidth - width - 8),
    });
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [anchor]);

  useEffect(() => {
    const select = (item: Item) => {
      onClose();
      item.onSelect();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        anchor.focus();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const item = items.find((i) => i.key === e.key.toUpperCase());
      if (item) {
        e.preventDefault();
        select(item);
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onClose);
    };
  });

  return createPortal(
    <div
      ref={menu}
      className="session-menu"
      role="menu"
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden", top: 0, left: 0 }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={item.danger ? "danger" : ""}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
          <kbd>{item.key}</kbd>
        </button>
      ))}
    </div>,
    document.body,
  );
}
