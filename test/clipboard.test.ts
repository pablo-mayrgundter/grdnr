import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsImagePaste, imageFileFromClipboard, isTextPasteTarget } from "../src/lib/clipboard.ts";

const bytes = () => Uint8Array.from([1, 2, 3, 4]);
const png = (name = "shot.png", type = "image/png") => new File([bytes()], name, { type });

test("takes an image file from the clipboard", () => {
  const file = png();
  assert.equal(imageFileFromClipboard({ files: [file] }), file);
});

test("prefers a real file and ignores text and empty images", () => {
  const file = png("bed.jpg", "image/jpeg");
  const empty = new File([], "empty.png", { type: "image/png" });
  const note = new File(["hi"], "note.txt", { type: "text/plain" });
  const later = png();
  assert.equal(
    imageFileFromClipboard({
      files: [note, empty, file],
      items: [{ kind: "file", type: "image/png", getAsFile: () => later }],
    }),
    file,
  );
  assert.equal(imageFileFromClipboard(null), null);
  assert.equal(imageFileFromClipboard({ files: [note] }), null);
});

test("a screenshot item with no MIME type becomes an image file", () => {
  const file = new File([bytes()], "image.png", { type: "" });
  const got = imageFileFromClipboard({
    files: [],
    items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
  });
  assert.equal(got?.type, "image/png");
  assert.equal(got?.size, 4);
  assert.equal(got?.name, "image.png");
});

test("a nameless image gets a file name", () => {
  const file = new File([bytes()], "", { type: "image/jpeg" });
  const got = imageFileFromClipboard({ files: [file] });
  assert.equal(got?.type, "image/jpeg");
  assert.equal(got?.name, "pasted.jpg");
});

test("an extension is enough when the MIME type is missing", () => {
  const file = new File([bytes()], "packet.heic", { type: "" });
  const got = imageFileFromClipboard({ files: [file] });
  assert.equal(got?.type, "image/heic");
  assert.equal(got?.name, "packet.heic");
});

test("image paste targeting", () => {
  assert.equal(acceptsImagePaste({ inside: true, hovered: false, inOtherWidget: false, textFieldWithText: false }), true);
  assert.equal(acceptsImagePaste({ inside: true, hovered: false, inOtherWidget: false, textFieldWithText: true }), false);
  assert.equal(acceptsImagePaste({ inside: false, hovered: true, inOtherWidget: false, textFieldWithText: false }), true);
  assert.equal(acceptsImagePaste({ inside: false, hovered: true, inOtherWidget: false, textFieldWithText: true }), false);
  assert.equal(acceptsImagePaste({ inside: false, hovered: true, inOtherWidget: true, textFieldWithText: false }), false);
  assert.equal(acceptsImagePaste({ inside: false, hovered: false, inOtherWidget: false, textFieldWithText: false }), false);
});

test("text fields keep text pastes, file inputs do not", () => {
  assert.equal(isTextPasteTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextPasteTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTextPasteTarget({ tagName: "INPUT", type: "date" }), true);
  assert.equal(isTextPasteTarget({ tagName: "INPUT", type: "file" }), false);
  assert.equal(isTextPasteTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTextPasteTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTextPasteTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTextPasteTarget(null), false);
});
