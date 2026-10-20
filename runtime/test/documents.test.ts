import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "../src/documents.ts";
import { saveAttachments, validateAttachments } from "../src/attachments.ts";

const python = process.env.FORGE_DOCUMENT_PYTHON || new URL("../../.venv/bin/python", import.meta.url).pathname;
const available = existsSync(python);
test("real document conversion: DOCX/PDF/XLSX/PPTX, malformed archives and conversation input", { skip: !available && "Install packages/documents/requirements.txt in .venv to test real conversion" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-documents-"));
  try {
    execFileSync(python, ["-c", String.raw`
import sys,zipfile
from pathlib import Path
from openpyxl import Workbook
from pptx import Presentation
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'product.docx','w') as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Product document 产品资料</w:t></w:r></w:p></w:body></w:document>')
w=Workbook();w.active.title='Sales';w.active.append(['Product','Price']);w.active.append(['Cup',19]);w.save(p/'sales.xlsx')
r=Presentation();s=r.slides.add_slide(r.slide_layouts[1]);s.shapes.title.text='Product presentation';r.save(p/'slides.pptx')
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
stream=b'BT /F1 12 Tf 72 720 Td (Product PDF) Tj ET';objects.append(b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream')
out=b'%PDF-1.4\n';offsets=[0]
for i,obj in enumerate(objects,1):
 offsets.append(len(out));out+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
xref=len(out);out+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(('%010d 00000 n \n'%x).encode() for x in offsets[1:]);out+=b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(xref).encode()+b'\n%%EOF';(p/'product.pdf').write_bytes(out)
with zipfile.ZipFile(p/'bad.docx','w') as z:z.writestr('wrong.xml','bad')
`, home]);
    for (const [name, expected] of [["product.docx", "产品资料"], ["sales.xlsx", "Cup"], ["slides.pptx", "Product presentation"], ["product.pdf", "Product PDF"]]) {
      assert.ok((await parseDocument(join(home, name!))).includes(expected!));
    }
    await assert.rejects(parseDocument(join(home, "product.pdf"), 1), /超时/);
    await assert.rejects(parseDocument(join(home, "bad.docx")), /扩展名不符/);
    const file = { name: "product.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: (await readFile(join(home, "product.docx"))).toString("base64") };
    const saved = await saveAttachments(home, validateAttachments([file]));
    assert.match(saved.text, /产品资料/);
    assert.equal(saved.images.length, 0);
    assert.throws(() => validateAttachments([{ ...file, name: "wrong.pdf" }]));
  } finally { await rm(home, { recursive: true, force: true }); }
});
