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
    const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "text/plain";
    return { name: file.name, mimeType, data };
  }));
}
