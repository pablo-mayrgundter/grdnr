/** A clipboard paste, or the same shape in tests. `DataTransfer` satisfies this. */
export type ClipboardSnapshot = {
  files?: ArrayLike<File>;
  items?: ArrayLike<{
    kind: string;
    type: string;
    getAsFile?: () => File | null;
  }>;
};

const TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  avif: "image/avif",
};

function extensionFor(type: string): string {
  if (type === "image/jpeg") return "jpg";
  const ext = type.slice("image/".length).split("+")[0]?.split(";")[0] ?? "";
  return ext || "png";
}

function typeFromName(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TYPE_BY_EXT[ext] ?? null;
}

/** Give a pasted image a MIME type and a file name. Screenshots often arrive with neither filled in. */
function asImage(file: File, typeHint?: string): File | null {
  const hinted = typeHint?.startsWith("image/") ? typeHint : null;
  const type = file.type.startsWith("image/") ? file.type : hinted ?? typeFromName(file.name);
  if (!type?.startsWith("image/") || file.size <= 0) return null;
  if (file.type === type && file.name) return file;
  return new File([file], file.name || `pasted.${extensionFor(type)}`, { type, lastModified: file.lastModified });
}

/** The first image on a clipboard paste. Text and empty files are skipped. */
export function imageFileFromClipboard(data: ClipboardSnapshot | null | undefined): File | null {
  if (!data) return null;
  if (data.files) {
    for (const file of Array.from(data.files)) {
      const image = asImage(file);
      if (image) return image;
    }
  }
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile?.();
      if (!file) continue;
      const image = asImage(file, item.type);
      if (image) return image;
    }
  }
  return null;
}

/**
 * Whether this photo widget should take an image paste.
 * A text field keeps a paste that includes text (a caption, a note).
 * Otherwise the widget takes it when the paste landed inside it, or when the pointer is over it
 * and the paste didn't land in a different photo widget.
 */
export function acceptsImagePaste(opts: {
  inside: boolean;
  hovered: boolean;
  inOtherWidget: boolean;
  textFieldWithText: boolean;
}): boolean {
  if (opts.textFieldWithText) return false;
  if (opts.inside) return true;
  if (opts.inOtherWidget) return false;
  return opts.hovered;
}

/** True for fields a person pastes writing into. File inputs are photo pickers, so they don't count. */
export function isTextPasteTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  if ("isContentEditable" in target && (target as { isContentEditable?: boolean }).isContentEditable) return true;
  const tag = "tagName" in target ? String((target as { tagName: string }).tagName).toUpperCase() : "";
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = "type" in target ? String((target as { type: string }).type).toLowerCase() : "text";
  return type !== "file" && type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "reset" && type !== "range" && type !== "color";
}

/** Read an image the user just asked for, via the async clipboard API. Null when the clipboard has no image. */
export async function readClipboardImage(): Promise<File | null> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
    throw new Error("Select the photo and paste.");
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    const file = imageFileFromClipboard({ files: [new File([blob], `pasted.${extensionFor(type)}`, { type: blob.type || type })] });
    if (file) return file;
  }
  return null;
}
