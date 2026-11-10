import * as z from "zod";
import { companyInput, fikenId, resolveCompany, ToolError } from "./common.ts";
import { defineTool, READ_ONLY } from "./tool.ts";

/** Claude takes images up to 5 MB. PDFs may be larger, but a bigger file is rarely a receipt. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The file types Fiken accepts in the inbox. */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

export const readInboxFile = defineTool({
  name: "read_inbox_file",
  access: "read",
  title: "Les fil fra innboksen",
  description: "Filen til et dokument i innboksen (PDF eller bilde, maks 5 MB), så du kan lese den. id fra find_inbox.",
  inputSchema: z.object({
    company: companyInput,
    id: fikenId("Dokument-ID fra find_inbox"),
  }),
  annotations: READ_ONLY,
  async handler(input, { fiken }) {
    const companySlug = await resolveCompany(fiken, input.company);
    const { data } = await fiken.api.GET("/companies/{companySlug}/inbox/{inboxDocumentId}", {
      params: { path: { companySlug, inboxDocumentId: input.id } },
    });
    if (!data?.documentUrl) throw new ToolError("Fiken har ingen fil for dette dokumentet.");

    const response = await fiken.download(data.documentUrl);
    const filename = data.filename ?? data.name ?? "dokument";
    const mimeType = mimeTypeOf(response.headers.get("content-type"), filename);
    if (mimeType === undefined) throw new ToolError(`Filtypen til ${filename} kan ikke leses her. Åpne den i Fiken.`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ToolError(`${filename} er større enn 5 MB. Åpne den i Fiken.`);

    const document = { id: data.documentId, name: data.name, filename, mimeType, bytes: bytes.byteLength };
    const base64 = toBase64(bytes);
    const file =
      mimeType === "application/pdf"
        ? { type: "resource" as const, resource: { uri: data.documentUrlWithFikenNormalUserCredentials ?? data.documentUrl, mimeType, blob: base64 } }
        : { type: "image" as const, data: base64, mimeType };
    return { content: [{ type: "text", text: JSON.stringify({ document }) }, file], structuredContent: { document } };
  },
});

/** The type Fiken sends, when it is one we can pass on; otherwise the type the file name says. */
function mimeTypeOf(contentType: string | null, filename: string): string | undefined {
  const known = new Set(Object.values(MIME_BY_EXTENSION));
  const sent = contentType?.split(";")[0]?.trim().toLowerCase();
  if (sent && known.has(sent)) return sent;
  return MIME_BY_EXTENSION[filename.split(".").at(-1)?.toLowerCase() ?? ""];
}

/** Web-standard base64, in chunks so large files do not overflow the argument list. */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let start = 0; start < view.length; start += 0x8000) {
    binary += String.fromCharCode(...view.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
