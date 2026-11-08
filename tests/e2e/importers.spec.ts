import { test, expect } from "@playwright/test";
function pdfFixture(): number[] {
  const stream =
    "BT /F1 12 Tf 50 750 Td (Memory has an owner. The owner manages its lifetime.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => `${o.toString().padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return [...Buffer.from(pdf)];
}
test("actual Monaco tokenizer protects string literals and finds code comments", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/importers.ts";
    const { extractCode } = await import(path);
    return await extractCode(
      'fn main() {\n    let s = "// Do not translate this string";\n    // Read the current value.\n    println!("{s}");\n}',
      "sample.rs",
    );
  });
  expect(
    result.segments
      .filter((s: { kind: string }) => s.kind === "comment")
      .map((s: { text: string }) => s.text),
  ).toEqual(["Read the current value."]);
  expect(
    result.segments.find((s: { id: string }) => s.id === "line2").text,
  ).toContain("Do not translate this string");
});
test("PDF.js extraction retains page positions and reports pages without text", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (bytes) => {
    const path = "/src/importers.ts";
    const { extractPdf } = await import(path);
    return await extractPdf(new Uint8Array(bytes));
  }, pdfFixture());
  expect(result.segments[0].text).toBe("Memory has an owner.");
  expect(result.segments[0].location.page).toBe(1);
  expect(result.segments[0].location.rect).toHaveLength(4);
  expect(
    result.warnings.some((s: string) =>
      s.includes("p.2: 文字情報がありません"),
    ),
  ).toBe(true);
});
