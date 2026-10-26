import { useAuth } from "../auth/useAuth";
import { focusPageHeading } from "../lib/focus";

/** The dismissible banner for a failed `/me` or a failed sign-out. */
export function AuthNotice() {
  const { notice, retry, dismissNotice } = useAuth();
  if (!notice) return null;

  async function handleRetry() {
    if (await retry()) focusPageHeading();
  }

  return (
    <div className="banner" role="alert">
      <p>{notice.message}</p>
      <div className="banner-actions">
        {notice.canRetry && (
          <button type="button" className="button" onClick={() => void handleRetry()}>
            Try again
          </button>
        )}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            dismissNotice();
            focusPageHeading();
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
