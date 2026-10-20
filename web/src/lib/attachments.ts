export const DOCUMENT_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

export async function encodeAttachments(files: File[]): Promise<Array<{ name: string; mimeType: string; data: string }>> {
  return Promise.all(files.map(async (file) => {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]!);
      reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
      reader.onabort = () => reject(new Error("附件读取已取消"));
      reader.readAsDataURL(file);
    });
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : DOCUMENT_MIME[extension ?? ""] ?? "text/plain";
    return { name: file.name, mimeType, data };
  }));
}

const FILE_KINDS: Record<string, string> = {
  pdf: "PDF 文档",
  docx: "Word 文档",
  xlsx: "Excel 表格",
  pptx: "PowerPoint 演示文稿",
  md: "Markdown",
  csv: "CSV 表格",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  log: "日志",
  txt: "文本",
};

export function fileExtension(name: string): string {
  return name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
}

/** Human label for a file type, e.g. "PDF 文档"; falls back to the upper-cased extension. */
export function fileKind(name: string): string {
  const extension = fileExtension(name);
  return FILE_KINDS[extension] ?? (extension.toUpperCase() || "文件");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
