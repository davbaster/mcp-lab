import { splitInlineCode } from "./inlineCode";

/** Quiz text with its backtick spans as `<code>`. React elements and text nodes only, never markup. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((segment, index) =>
        segment.code ? <code key={index}>{segment.text}</code> : segment.text,
      )}
    </>
  );
}
