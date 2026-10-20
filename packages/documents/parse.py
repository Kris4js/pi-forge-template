"""One local file per subprocess; stdout is a single JSON result, never logs."""
import json
import socket
import sys
import zipfile
from pathlib import Path

MAX_TEXT = 100_000


def convert(path):
    # Disable network access, including external relationships in uploaded Office files.
    def offline(*args, **kwargs):
        raise RuntimeError("文档解析禁止网络访问")
    socket.socket.connect = offline
    socket.create_connection = offline
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        if sys.platform == "linux":
            resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    except (ImportError, ValueError, OSError):
        pass
    suffix = Path(path).suffix.lower()
    expected = {".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml"}
    if suffix in expected:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 5000 or sum(item.file_size for item in entries) > 256 * 1024**2:
                raise ValueError("Office 解压体积或文件数量超限")
            names = {item.filename for item in entries}
            if expected[suffix] not in names or "[Content_Types].xml" not in names:
                raise ValueError("Office 文件内容与扩展名不符")
            if any(item.flag_bits & 1 or "vbaproject" in item.filename.lower() or item.filename.startswith("/") or ".." in Path(item.filename).parts for item in entries):
                raise ValueError("不支持加密、宏或异常 Office 文件")
        if suffix == ".xlsx":
            from openpyxl import load_workbook
            workbook = load_workbook(path, read_only=True, data_only=True, keep_links=False)
            try:
                if len(workbook.worksheets) > 50:
                    raise ValueError("Excel 最多 50 个工作表")
                cells = 0
                for sheet in workbook:
                    for row in sheet.iter_rows():
                        cells += len(row)
                        if cells > 100_000:
                            raise ValueError("Excel 超过 100000 个单元格，请拆分文件")
            finally:
                workbook.close()
    elif suffix == ".pdf":
        from pdfminer.pdfparser import PDFParser
        from pdfminer.pdfdocument import PDFDocument
        from pdfminer.pdfpage import PDFPage
        with open(path, "rb") as source:
            document = PDFDocument(PDFParser(source))
            if document.encryption:
                raise ValueError("不支持加密 PDF")
            for index, _ in enumerate(PDFPage.create_pages(document)):
                if index >= 200:
                    raise ValueError("PDF 最多 200 页，请拆分文件")
    else:
        raise ValueError("不支持的文档格式")
    from markitdown import MarkItDown
    text = MarkItDown(enable_plugins=False).convert(path).text_content.strip()
    if not text:
        raise ValueError("未提取到文字；扫描件或图片型文档需要 OCR，当前尚不支持")
    if len(text) > MAX_TEXT:
        raise ValueError("提取文字超过 100000 字符，请拆分文档")
    return text


if __name__ == "__main__":
    try:
        print(json.dumps({"text": convert(sys.argv[1])}, ensure_ascii=False))
    except Exception as error:
        # Do not expose document text, local paths or credentials in conversion errors.
        message = str(error) if isinstance(error, ValueError) else "文件损坏、加密或解析失败；请转换为未加密的标准文档后重试"
        print(json.dumps({"error": message}, ensure_ascii=False))
        sys.exit(1)
