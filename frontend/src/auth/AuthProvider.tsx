import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toApiError, type ApiError } from "../api/apiError";
import { api, type ApiMiddleware } from "../api/client";
import { AuthContext, type AuthNotice, type AuthValue } from "./authContext";

interface Session {
  status: "loading" | "learner" | "visitor";
  username: string | null;
}

const LOADING: Session = { status: "loading", username: null };
const VISITOR: Session = { status: "visitor", username: null };

/**
 * Knows who is using the app. The session itself is the server's HTTP-only cookie: nothing about
 * it is written to storage or cookies here. One `GET /api/auth/me` at start decides the state.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(LOADING);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  // Bumped when the cookie changes (sign in, register, sign out). A response to a request that
  // started under an older number says nothing about the current session.
  const epoch = useRef(0);
  const started = useRef(false);
  const meInFlight = useRef(false);
  const signOutInFlight = useRef(false);

  const loadMe = useCallback(async (): Promise<boolean> => {
    const startedAt = epoch.current;
    let failure: ApiError | null = null;
    let username: string | null = null;
    try {
      const { data, error, response } = await api.GET("/api/auth/me");
      if (response.ok && data) username = data.username;
      else failure = toApiError(error, response);
    } catch (thrown) {
      failure = toApiError(thrown);
    }
    // Someone signed in or out while this was running: this answer is old.
    if (epoch.current !== startedAt) return true;
    if (username !== null) {
      setSession({ status: "learner", username });
      setNotice(null);
      return true;
    }
    setSession(VISITOR);
    if (failure?.status === 401) {
      setNotice(null);
      return true;
    }
    setNotice({ message: failure?.message ?? "", canRetry: true });
    return false;
  }, []);

  useEffect(() => {
    // Also once under StrictMode's second run of this effect.
    if (started.current) return;
    started.current = true;
    void loadMe();
  }, [loadMe]);

  const retry = useCallback(async (): Promise<boolean> => {
    if (meInFlight.current) return false;
    meInFlight.current = true;
    setSession(LOADING);
    try {
      return await loadMe();
    } finally {
      meInFlight.current = false;
    }
  }, [loadMe]);

  // Any response of 401 `not_authenticated` means the session ended: become a visitor.
  // A layout effect, so it is in place before the first request that any child's effect sends.
  useLayoutEffect(() => {
    const requestEpoch = new Map<string, number>();
    const middleware: ApiMiddleware = {
      onRequest({ id }) {
        requestEpoch.set(id, epoch.current);
      },
      onError({ id }) {
        requestEpoch.delete(id);
      },
      async onResponse({ id, response }) {
        const startedAt = requestEpoch.get(id);
        requestEpoch.delete(id);
        if (response.status !== 401 || startedAt !== epoch.current) return;
        let body: unknown;
        try {
          // A clone, so the page that made the call can still read its own body.
          body = await response.clone().json();
        } catch {
          return;
        }
        if (toApiError(body, response).code !== "not_authenticated") return;
        if (startedAt !== epoch.current) return;
        // Also discards a slower `/me` that started earlier and would say the opposite.
        epoch.current += 1;
        setSession(VISITOR);
      },
    };
    api.use(middleware);
    return () => api.eject(middleware);
  }, []);

  const signedIn = useCallback((username: string) => {
    epoch.current += 1;
    setSession({ status: "learner", username });
    setNotice(null);
  }, []);

  const signIn = useCallback(
    async (username: string, password: string): Promise<ApiError | null> => {
      try {
        const { data, error, response } = await api.POST("/api/auth/login", { body: { username, password } });
        if (!response.ok || !data) return toApiError(error, response);
        signedIn(data.username);
        return null;
      } catch (thrown) {
        return toApiError(thrown);
      }
    },
    [signedIn],
  );

  const register = useCallback(
    async (username: string, password: string): Promise<ApiError | null> => {
      try {
        const { data, error, response } = await api.POST("/api/auth/register", { body: { username, password } });
        if (!response.ok || !data) return toApiError(error, response);
        signedIn(data.username);
        return null;
      } catch (thrown) {
        return toApiError(thrown);
      }
    },
    [signedIn],
  );

  const signOut = useCallback(async (): Promise<boolean> => {
    if (signOutInFlight.current) return false;
    signOutInFlight.current = true;
    try {
      const { error, response } = await api.POST("/api/auth/logout");
      if (response.ok) {
        epoch.current += 1;
        setSession(VISITOR);
        setNotice(null);
        return true;
      }
      // Still signed in: the cookie may still be valid.
      setNotice({ message: toApiError(error, response).message, canRetry: false });
    } catch (thrown) {
      setNotice({ message: toApiError(thrown).message, canRetry: false });
    } finally {
      signOutInFlight.current = false;
    }
    return false;
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<AuthValue>(
    () => ({
      status: session.status,
      username: session.username,
      notice,
      signIn,
      register,
      signOut,
      retry,
      dismissNotice,
    }),
    [session, notice, signIn, register, signOut, retry, dismissNotice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
