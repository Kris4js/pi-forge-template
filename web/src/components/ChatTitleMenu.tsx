import { ChevronDown, FolderClosed, FolderInput, FolderMinus, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Project, SessionSummary } from "../api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type Props = {
  session: SessionSummary;
  title: string;
  projects: Project[];
  /** The session has a run in progress: changes that append to its history wait until it ends. */
  busy: boolean;
  onPin: (pinned: boolean) => void;
  onRename: (name: string) => void;
  onMove: (projectId: string | null) => void;
  onCreateProject: () => void;
  onDelete: () => void;
};

/** The conversation title in the top bar, with its actions behind a chevron that appears on hover. */
export function ChatTitleMenu({ session, title, projects, busy, onPin, onRename, onMove, onCreateProject, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const inProject = !!session.projectId && projects.some((p) => p.id === session.projectId);
  const targets = projects.filter((p) => p.id !== session.projectId);

  // P / R / D act while the menu is open, as in the sidebar row menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const key = e.key.toUpperCase();
      if (key === "P") onPin(!session.pinned);
      else if (key === "R" && !busy) setRenaming(true);
      else if (key === "D" && !busy) onDelete();
      else return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, session.pinned, onPin, onDelete]);

  if (renaming) {
    return (
      <TitleInput
        initial={title}
        onDone={(name) => {
          setRenaming(false);
          if (name && name !== title) onRename(name);
        }}
      />
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className={`chat-title ${open ? "open" : ""}`} aria-label={`${title}：会话操作`}>
        <span className="chat-title-text" title={title}>{title}</span>
        <span className="chat-title-chevron" aria-hidden="true"><ChevronDown size={14} /></span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="chat-title-menu" align="start" sideOffset={6}>
        <DropdownMenuItem onClick={() => onPin(!session.pinned)}>
          {session.pinned ? <PinOff /> : <Pin />}
          {session.pinned ? "取消置顶" : "置顶"}
          <DropdownMenuShortcut>P</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => setRenaming(true)}>
          <Pencil />
          重命名
          <DropdownMenuShortcut>R</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={busy}>
            <FolderInput />
            {inProject ? "更改项目" : "添加到项目"}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="chat-title-menu project-targets">
            {targets.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onMove(p.id)}>
                <FolderClosed />
                <span className="dropdown-menu-item-text" title={p.name}>{p.name}</span>
              </DropdownMenuItem>
            ))}
            {targets.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={onCreateProject}>
              <Plus />
              新建项目
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {inProject && (
          <DropdownMenuItem disabled={busy} onClick={() => onMove(null)}>
            <FolderMinus />
            从项目中移除
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={busy} onClick={onDelete}>
          <Trash2 />
          删除
          <DropdownMenuShortcut>D</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TitleInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="chat-title-input"
      aria-label="会话名称"
      value={value}
      maxLength={80}
      size={Math.max(8, Math.min(40, value.length + 2))}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") finish(value.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value.trim() || null)}
    />
  );
}
