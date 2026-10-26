import { LogOnce } from "./LogOnce";

/**
 * The box for content that cannot be shown. `problem` goes to the console, never to the page.
 * `message` is the text for a component that has its own wording ("This code step can't be shown").
 */
export function Unavailable({
  name,
  problem,
  message = "This content can't be shown",
}: {
  name: string;
  problem: string | null;
  message?: string;
}) {
  return (
    <div className="content-unavailable">
      {message}
      {problem !== null && <LogOnce level="error" message={`Lesson component "${name}" can't be shown: ${problem}`} />}
    </div>
  );
}
