import { FileText, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export const ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.yaml,.yml,.log";

export function AttachmentButton({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return <>
    <input ref={input} type="file" hidden multiple accept={ATTACHMENT_ACCEPT} disabled={disabled} onChange={(event) => {
      const next = [...files, ...Array.from(event.target.files ?? [])];
      event.target.value = "";
      if (next.length > 4 || next.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) { setError("最多 4 个附件，合计不超过 8 MB"); return; }
      if (next.some((file) => !file.size || file.size > 4 * 1024 * 1024 || !/\.(png|jpe?g|webp|txt|md|csv|json|ya?ml|log)$/i.test(file.name))) { setError("请选择 PNG、JPEG、WebP 或文本文件，单个最大 4 MB"); return; }
      if (next.some((file) => !/\.(png|jpe?g|webp)$/i.test(file.name) && file.size > 100_000)) { setError("文本附件最大 100 KB"); return; }
      setError(""); onChange(next);
    }} />
    <DropdownMenu>
      <DropdownMenuTrigger className="attachment-add" aria-label="添加附件" title="添加附件" disabled={disabled}><Plus size={18} /></DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem onClick={() => input.current?.click()}><Paperclip size={16} />上传照片和文件</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <span className="attachment-error" role="alert">{error}</span>}
  </>;
}

export function AttachmentPreview({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) return;
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return <div className="composer-attachment">
    {url ? <img src={url} alt={file.name} /> : <FileText size={24} />}
    <span title={file.name}>{file.name}<small>{Math.ceil(file.size / 1024)} KB</small></span>
    <button type="button" aria-label={`移除 ${file.name}`} disabled={disabled} onClick={onRemove}><X size={14} /></button>
  </div>;
}
