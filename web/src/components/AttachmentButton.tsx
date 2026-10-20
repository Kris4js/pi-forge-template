import { FileText, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export const ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.yaml,.yml,.log";

const IMAGE = /\.(png|jpe?g|webp)$/i;
const PASTED_EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Returns why `files` can't be attached, or "" when they can. */
export function attachmentError(files: File[]): string {
  if (files.length > 20 || files.reduce((sum, file) => sum + file.size, 0) > 80 * 1024 * 1024) return "最多 20 个附件，合计不超过 80 MB";
  if (files.some((file) => !file.size || file.size > 4 * 1024 * 1024 || !/\.(png|jpe?g|webp|txt|md|csv|json|ya?ml|log)$/i.test(file.name))) return "请选择 PNG、JPEG、WebP 或文本文件，单个最大 4 MB";
  if (files.some((file) => !IMAGE.test(file.name) && file.size > 100_000)) return "文本附件最大 100 KB";
  return "";
}

/** Clipboard images come in as "image.png" (or nameless); give them a unique name whose extension matches the type. */
export function pastedFiles(files: File[]): File[] {
  const stamp = Date.now();
  return files.map((file, index) => {
    const extension = PASTED_EXTENSION[file.type];
    if (!extension || (IMAGE.test(file.name) && !/^image\.\w+$/i.test(file.name))) return file;
    return new File([file], `pasted-${stamp}${index ? `-${index}` : ""}.${extension}`, { type: file.type, lastModified: file.lastModified });
  });
}

export function AttachmentButton({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return <>
    <input ref={input} type="file" hidden multiple accept={ATTACHMENT_ACCEPT} disabled={disabled} onChange={(event) => {
      const next = [...files, ...Array.from(event.target.files ?? [])];
      event.target.value = "";
      const problem = attachmentError(next);
      setError(problem);
      if (!problem) onChange(next);
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
    if (!IMAGE.test(file.name)) return;
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return <div className={`composer-attachment ${url ? "image" : "file"}`} title={file.name}>
    {url ? <img src={url} alt={file.name} /> : <>
      <FileText size={20} />
      <span>{file.name}<small>{Math.ceil(file.size / 1024)} KB</small></span>
    </>}
    <button type="button" aria-label={`移除 ${file.name}`} disabled={disabled} onClick={onRemove}><X size={12} /></button>
  </div>;
}
