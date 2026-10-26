import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { registerPath, returnTarget, signInPath } from "../auth/paths";
import { useAuth } from "../auth/useAuth";

/** The right side of the header: sign-in links, or the username and "Sign out". */
export function AccountNav() {
  const { status, username, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // The disabled button cannot take focus, so give it back once it works again.
  useEffect(() => {
    if (!signingOut && restoreFocus.current) {
      restoreFocus.current = false;
      button.current?.focus();
    }
  }, [signingOut]);

  const next = returnTarget(location);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    const signedOut = await signOut();
    if (signedOut) {
      navigate("/", { state: { focusHeading: true } });
    } else {
      restoreFocus.current = true;
    }
    setSigningOut(false);
  }

  return (
    <nav className="account-nav" aria-label="Account">
      {status === "visitor" && (
        <>
          <Link to={signInPath(next)}>Sign in</Link>
          <Link to={registerPath(next)}>Create account</Link>
        </>
      )}
      {status === "learner" && (
        <>
          <span className="username">{username}</span>
          <button
            ref={button}
            type="button"
            className="button button-secondary"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </>
      )}
    </nav>
  );
}
