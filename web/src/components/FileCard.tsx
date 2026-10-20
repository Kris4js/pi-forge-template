import { FileSpreadsheet, FileText, Presentation } from "lucide-react";
import { fileTypeIcons } from "../../shared/file-types";
import type { FileAsset } from "../api";
import { fileExtension, fileKind, formatFileSize } from "../lib/attachments";

const ICONS: Record<string, string> = { docx: fileTypeIcons.word, xlsx: fileTypeIcons.excel, csv: fileTypeIcons.excel, pdf: fileTypeIcons.pdf, md: fileTypeIcons.markdown };

/** Type icon for an attachment: the brand artwork when we have it, otherwise a tinted glyph. */
export function FileIcon({ name, size = 24 }: { name: string; size?: number }) {
  const extension = fileExtension(name);
  const src = ICONS[extension];
  if (src) return <img className="file-icon" src={src} alt="" />;
  const Glyph = extension === "pptx" ? Presentation : extension === "xlsx" ? FileSpreadsheet : FileText;
  return <Glyph className="file-icon" size={size} />;
}

/** A sent attachment on the user's message: icon, name, type and size. */
export function FileCard({ file }: { file: FileAsset }) {
  const extension = fileExtension(file.name);
  return (
    <div className="file-card" data-type={extension} title={file.name}>
      <span className="file-card-icon"><FileIcon name={file.name} size={20} /></span>
      <span className="file-card-info">
        <span className="file-card-name">{file.name}</span>
        <span className="file-card-meta">{file.size === undefined ? fileKind(file.name) : `${fileKind(file.name)} · ${formatFileSize(file.size)}`}</span>
      </span>
    </div>
  );
}
