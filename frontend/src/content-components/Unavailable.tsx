import { LogOnce } from "./LogOnce";

/** The box for content that cannot be shown. `problem` goes to the console, never to the page. */
export function Unavailable({ name, problem }: { name: string; problem: string | null }) {
  return (
    <div className="content-unavailable">
      This content can't be shown
      {problem !== null && <LogOnce level="error" message={`Lesson component "${name}" can't be shown: ${problem}`} />}
    </div>
  );
}
