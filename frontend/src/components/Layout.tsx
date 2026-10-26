import { useEffect, useRef, type MouseEvent } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { focusPageHeading } from "../lib/focus";
import { AccountNav } from "./AccountNav";
import { AuthNotice } from "./AuthNotice";

/** After a path change, show the top of the new page and put focus on its `h1`. */
function useFocusOnRouteChange() {
  const location = useLocation();
  const previousPath = useRef(location.pathname);

  useEffect(() => {
    const pathChanged = previousPath.current !== location.pathname;
    previousPath.current = location.pathname;
    // A navigation can also ask for it (sign-out from the page it is already on).
    const asked = (location.state as { focusHeading?: boolean } | null)?.focusHeading === true;
    if (pathChanged || asked) {
      window.scrollTo(0, 0);
      focusPageHeading();
    }
  }, [location]);
}

/** The shared page frame: skip link, header, and `main`. */
export function Layout() {
  const main = useRef<HTMLElement>(null);
  useFocusOnRouteChange();

  function skipToMain(event: MouseEvent) {
    // Not a hash navigation: that would put "#main" in the router's URL.
    event.preventDefault();
    main.current?.focus();
  }

  return (
    <>
      <a className="skip-link" href="#main" onClick={skipToMain}>
        Skip to main content
      </a>
      <header className="site-header">
        <div className="container header-inner">
          <Link className="brand" to="/">
            Courses
          </Link>
          <AccountNav />
        </div>
      </header>
      <main id="main" className="container" ref={main} tabIndex={-1}>
        <AuthNotice />
        <Outlet />
      </main>
    </>
  );
}
