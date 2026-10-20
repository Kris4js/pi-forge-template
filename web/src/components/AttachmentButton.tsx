import { DOCUMENT_MIME, fileExtension, formatFileSize } from "../lib/attachments";
import { LoaderCircle, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FileIcon } from "./FileCard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export const ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.yaml,.yml,.log,.docx,.pdf,.xlsx,.pptx";

const IMAGE = /\.(png|jpe?g|webp)$/i;
const PASTED_EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const MAX_FILE_MB = 50;
const MAX_TOTAL_MB = 80;

/** Returns why `files` can't be attached, or "" when they can. */
export function attachmentError(files: File[]): string {
  if (files.length > 20) return "上传失败：最多添加 20 个附件";
  if (files.some((file) => !/\.(png|jpe?g|webp|txt|md|csv|json|ya?ml|log|docx|pdf|xlsx|pptx)$/i.test(file.name))) return "上传失败：不支持的文件类型";
  if (files.some((file) => !file.size)) return "上传失败：文件内容为空";
  if (files.some((file) => file.size > MAX_FILE_MB * 1024 * 1024)) return `上传失败：超过最大文件大小限制（${MAX_FILE_MB} MB）`;
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_MB * 1024 * 1024) return `上传失败：附件合计超过 ${MAX_TOTAL_MB} MB`;
  if (files.some((file) => !IMAGE.test(file.name) && !DOCUMENT_MIME[file.name.split(".").at(-1)?.toLowerCase() ?? ""] && file.size > 100_000)) return "上传失败：文本附件最大 100 KB";
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

export function AttachmentButton({ files, onChange, onError, disabled }: { files: File[]; onChange: (files: File[]) => void; onError: (message: string) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" hidden multiple accept={ATTACHMENT_ACCEPT} disabled={disabled} onChange={(event) => {
      const next = [...files, ...Array.from(event.target.files ?? [])];
      event.target.value = "";
      const problem = attachmentError(next);
      onError(problem);
      if (!problem) onChange(next);
    }} />
    <DropdownMenu>
      <DropdownMenuTrigger className="attachment-add" aria-label="添加附件" title="添加附件" disabled={disabled}><Plus size={18} /></DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem onClick={() => input.current?.click()}><Paperclip size={16} />上传照片和文件</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}

export function AttachmentPreview({ file, uploading, disabled, onRemove }: { file: File; uploading?: boolean; disabled: boolean; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!IMAGE.test(file.name)) return;
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  const extension = fileExtension(file.name);
  return <div className={`composer-attachment ${url ? "image" : "file"}`} title={file.name} aria-busy={uploading || undefined}>
    {url ? <img className="attachment-thumbnail" src={url} alt={file.name} /> : <>
      <FileIcon name={file.name} />
      <span className="attachment-file-info"><span className="attachment-file-name">{file.name}</span><small>{extension.toUpperCase() || "FILE"} · {formatFileSize(file.size)}</small></span>
    </>}
    {uploading && <div className="attachment-upload-overlay" role="status"><LoaderCircle size={20} /><span>上传并解析中…</span></div>}
    <button type="button" aria-label={`移除 ${file.name}`} disabled={disabled} onClick={onRemove}><X size={12} /></button>
  </div>;
}
