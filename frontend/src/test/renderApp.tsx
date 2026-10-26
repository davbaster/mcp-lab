/**
 * Renders the whole app (providers, layout, routes) at `url` in a memory router, as a browser
 * would at that address. Later page tasks reuse it:
 *
 *   apiRoutes({ ... });
 *   const { user, history } = renderApp("/courses/x/lessons/y");
 *
 * `user` is a user-event instance (typing, Tab, Enter, clicks). `history` lists every location
 * the router visited, with how it got there (`REPLACE` means Back does not return to the
 * previous page). `window.scrollTo` is stubbed because jsdom does not implement it.
 */
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, vi } from "vitest";
import App from "../App";
import { installDialogShim } from "./dialogShim";
import { LocationProbe, type Visit } from "./LocationProbe";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** `url` can also be `{ pathname, state }`, to open a history entry that carries state. */
export function renderApp(url: string | { pathname: string; state?: unknown } = "/", options: { strict?: boolean } = {}) {
  installDialogShim();
  const user = userEvent.setup();
  const visits: Visit[] = [];
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

  const tree = (
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe visits={visits} />
      <App />
    </MemoryRouter>
  );
  const view = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);

  return {
    ...view,
    user,
    scrollTo,
    history: visits,
    /** The current path, query and hash. */
    currentUrl: () => visits.at(-1)?.url ?? (typeof url === "string" ? url : url.pathname),
  };
}
