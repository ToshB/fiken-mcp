import type { FikenClient } from "./fiken/client.ts";
import { SERVER_DISPLAY_NAME } from "./server-info.ts";

/**
 * Receipts and vouchers the user uploads through a one-time link. The platform owns the link and
 * the page; core owns where the file goes in Fiken.
 */

export const UPLOAD_TARGET_TYPES = ["inbox", "purchase_draft", "sale_draft", "purchase", "sale"] as const;
export type UploadTargetType = (typeof UPLOAD_TARGET_TYPES)[number];

export interface UploadTarget {
  companySlug: string;
  type: UploadTargetType;
  /** The draft, purchase or sale. Not used for the inbox. */
  id?: number | undefined;
}

export interface UploadLink {
  url: string;
  expiresAt: string;
}

export type UploadLinkIssuer = (target: UploadTarget) => Promise<UploadLink>;

/** File types Fiken accepts for attachments (spec: "Must end with either .png, .jpeg, .jpg, .gif or .pdf"). */
export const UPLOAD_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".gif"] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface UploadFile {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

/** Why a file was refused, in Norwegian for the upload page; undefined when it is fine. */
export function checkUpload(file: UploadFile): string | undefined {
  const name = file.name.toLowerCase();
  if (!UPLOAD_EXTENSIONS.some((extension) => name.endsWith(extension))) return "Filen må være PDF, PNG, JPG eller GIF.";
  if (file.bytes.byteLength === 0) return "Filen er tom.";
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) return "Filen er større enn 10 MB.";
  return undefined;
}

/**
 * Sends the file to its target in Fiken as multipart, which every attachment endpoint takes.
 *
 * Fiken reads the text fields as Latin-1 (measured 16.10.2026: "æ" in UTF-8 came out as "Ã¦"), so the
 * body is built here with Latin-1 text fields instead of with FormData, which always writes UTF-8.
 */
export async function uploadAttachment(fiken: FikenClient, target: UploadTarget, file: UploadFile): Promise<void> {
  const problem = checkUpload(file);
  if (problem) throw new Error(problem);

  const fields: [string, string][] =
    target.type === "inbox"
      ? [["name", file.name], ["filename", file.name], ["description", `Lastet opp via ${SERVER_DISPLAY_NAME}`]]
      : [["filename", file.name]];
  const { body, contentType } = multipart(fields, file);
  const companySlug = target.companySlug;
  const init = { body: body as never, bodySerializer: (raw: unknown) => raw as BodyInit, headers: { "content-type": contentType } };

  if (target.type === "inbox") {
    await fiken.api.POST("/companies/{companySlug}/inbox", { params: { path: { companySlug } }, ...init });
    return;
  }
  await postAttachment(fiken, target, {}, init);
}

/**
 * Puts a document from the Fiken inbox on the target. Fiken marks it as used, and it stays used even
 * if the attachment is removed again (measured).
 */
export async function attachInboxDocument(fiken: FikenClient, target: UploadTarget, inboxDocumentId: number): Promise<void> {
  // Fiken answers 415 without a multipart body, even when the file comes from the inbox (measured).
  await postAttachment(fiken, target, { inboxDocumentId }, { body: new FormData() as never });
}

interface AttachmentBody {
  body: never;
  bodySerializer?: (raw: unknown) => BodyInit;
  headers?: Record<string, string>;
}

async function postAttachment(fiken: FikenClient, target: UploadTarget, query: { inboxDocumentId?: number }, init: AttachmentBody): Promise<void> {
  const { companySlug, id } = target;
  if (target.type === "inbox" || id === undefined) throw new Error("Attachment target needs a draft, purchase or sale id");
  // Booked purchases and sales refuse an attachment without one of these flags: 400 "Either
  // attachToPayment or attachToSale must be specified" (measured). A receipt documents the purchase.
  const booked = { ...query, attachToSale: true };
  switch (target.type) {
    case "purchase_draft":
      await fiken.api.POST("/companies/{companySlug}/purchases/drafts/{draftId}/attachments", { params: { path: { companySlug, draftId: id }, query }, ...init });
      return;
    case "sale_draft":
      await fiken.api.POST("/companies/{companySlug}/sales/drafts/{draftId}/attachments", { params: { path: { companySlug, draftId: id }, query }, ...init });
      return;
    case "purchase":
      await fiken.api.POST("/companies/{companySlug}/purchases/{purchaseId}/attachments", { params: { path: { companySlug, purchaseId: id }, query: booked }, ...init });
      return;
    case "sale":
      await fiken.api.POST("/companies/{companySlug}/sales/{saleId}/attachments", { params: { path: { companySlug, saleId: id }, query: booked }, ...init });
      return;
  }
}

/** Latin-1 bytes; characters outside Latin-1 become "_". */
export function latin1(text: string): Uint8Array {
  return Uint8Array.from([...text].map((char) => {
    const code = char.codePointAt(0) ?? 0x5f;
    return code <= 0xff ? code : 0x5f;
  }));
}

function multipart(fields: [string, string][], file: UploadFile): { body: Uint8Array; contentType: string } {
  const boundary = `----fiken-mcp-${crypto.randomUUID()}`;
  const ascii = (text: string) => new TextEncoder().encode(text);
  // The part's own filename only needs to be harmless in a header; Fiken shows the "filename" field.
  const safeName = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const parts = [
    ...fields.flatMap(([name, value]) => [ascii(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), latin1(value), ascii("\r\n")]),
    ascii(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`),
    new Uint8Array(file.bytes),
    ascii(`\r\n--${boundary}--\r\n`),
  ];
  const body = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
