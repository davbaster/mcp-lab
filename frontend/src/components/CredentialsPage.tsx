import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { nextTarget, registerPath, signInPath } from "../auth/paths";
import { useAuth } from "../auth/useAuth";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { PageHeading } from "./PageHeading";

type Mode = "login" | "register";
type Field = "username" | "password";
type FieldErrors = Partial<Record<Field, string>>;

interface FormError {
  message: string;
  /** "Try again in about 15 minutes." for a 429 with a usable `Retry-After`. */
  wait: string | null;
}

const USERNAME_RULE = /^[A-Za-z0-9_]{4,8}$/;

const REGISTER_USERNAME_MESSAGE = "Username must be 4 to 8 characters: letters, digits, and underscores.";
const REGISTER_PASSWORD_MESSAGE = "Password must be 8 to 12 characters.";

/** The server's rule: after NFKC normalization, counted by Unicode code points. */
function passwordLength(password: string): number {
  return [...password.normalize("NFKC")].length;
}

function validate(mode: Mode, username: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (mode === "register") {
    // The username is never trimmed: " abcd" is not valid.
    if (!USERNAME_RULE.test(username)) errors.username = REGISTER_USERNAME_MESSAGE;
    const length = passwordLength(password);
    if (length < 8 || length > 12) errors.password = REGISTER_PASSWORD_MESSAGE;
  } else {
    // Sign in accepts any existing account, so the register rules do not apply.
    if (username === "") errors.username = "Enter your username.";
    if (password === "") errors.password = "Enter your password.";
  }
  return errors;
}

function waitMessage(seconds: number): string {
  if (seconds < 60) return `Try again in about ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

const TEXT = {
  login: {
    heading: "Sign in",
    submit: "Sign in",
    busy: "Signing in…",
    passwordAutocomplete: "current-password",
  },
  register: {
    heading: "Create account",
    submit: "Create account",
    busy: "Creating account…",
    passwordAutocomplete: "new-password",
  },
} as const;

function CredentialsForm({ mode, next }: { mode: Mode; next: string | null }) {
  const { signIn, register } = useAuth();
  const text = TEXT[mode];
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<FormError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pendingFocus = useRef<Field | null>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  // Focus goes to the first invalid field once its error is linked to it.
  useEffect(() => {
    const field = pendingFocus.current;
    pendingFocus.current = null;
    if (field === "username") usernameInput.current?.focus();
    if (field === "password") passwordInput.current?.focus();
  }, [errors]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError(null);

    const found = validate(mode, username, password);
    setErrors(found);
    if (found.username || found.password) {
      pendingFocus.current = found.username ? "username" : "password";
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    const failure = await (mode === "login" ? signIn : register)(username, password);
    if (!failure) return; // Signed in: this page is replaced by the redirect.
    inFlight.current = false;
    setSubmitting(false);

    if (failure.code === "username_taken") {
      setErrors({ username: failure.message });
      pendingFocus.current = "username";
      return;
    }
    const wait =
      failure.code === "too_many_attempts" && failure.retryAfter !== null ? waitMessage(failure.retryAfter) : null;
    setFormError({ message: failure.message, wait });
  }

  function describedBy(field: Field): string | undefined {
    const ids: string[] = [];
    if (mode === "register") ids.push(`${field}-hint`);
    if (errors[field]) ids.push(`${field}-error`);
    return ids.length > 0 ? ids.join(" ") : undefined;
  }

  return (
    <>
      {formError && (
        <div className="error-box" role="alert">
          <p>{formError.message}</p>
          {formError.wait && <p>{formError.wait}</p>}
        </div>
      )}
      <form method="post" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            ref={usernameInput}
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            aria-invalid={errors.username ? "true" : undefined}
            aria-describedby={describedBy("username")}
            onChange={(event) => {
              setUsername(event.target.value);
              setErrors((current) => ({ ...current, username: undefined }));
            }}
          />
          {mode === "register" && (
            <p className="hint" id="username-hint">
              4 to 8 letters, digits, or underscores
            </p>
          )}
          {errors.username && (
            <p className="field-error" id="username-error">
              {errors.username}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            ref={passwordInput}
            id="password"
            name="password"
            type="password"
            autoComplete={text.passwordAutocomplete}
            value={password}
            aria-invalid={errors.password ? "true" : undefined}
            aria-describedby={describedBy("password")}
            onChange={(event) => {
              setPassword(event.target.value);
              setErrors((current) => ({ ...current, password: undefined }));
            }}
          />
          {mode === "register" && (
            <p className="hint" id="password-hint">
              8 to 12 characters
            </p>
          )}
          {errors.password && (
            <p className="field-error" id="password-error">
              {errors.password}
            </p>
          )}
        </div>
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? text.busy : text.submit}
        </button>
      </form>
      <p className="form-switch">
        {mode === "login" ? (
          <>
            No account yet? <Link className="link-action" to={registerPath(next)}>Create one</Link>
          </>
        ) : (
          <>
            Already have an account? <Link className="link-action" to={signInPath(next)}>Sign in</Link>
          </>
        )}
      </p>
    </>
  );
}

/** The page for `/login` and `/register`: for visitors only. */
export function CredentialsPage({ mode }: { mode: Mode }) {
  const { status } = useAuth();
  const [params] = useSearchParams();
  const next = params.get("next");
  useDocumentTitle(TEXT[mode].heading);

  return (
    <div className="form-column">
      <PageHeading>{TEXT[mode].heading}</PageHeading>
      {status === "loading" && <p role="status">Loading…</p>}
      {status === "learner" && <Navigate to={nextTarget(next)} replace />}
      {status === "visitor" && <CredentialsForm mode={mode} next={next} />}
    </div>
  );
}
