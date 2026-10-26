import { createContext } from "react";
import type { ApiError } from "../api/apiError";

export type AuthStatus = "loading" | "learner" | "visitor";

/** A banner shown at the top of `main`: a failed `/me` (can retry) or a failed sign-out. */
export interface AuthNotice {
  message: string;
  canRetry: boolean;
}

export interface AuthValue {
  /** `loading` until `/api/auth/me` has answered. */
  status: AuthStatus;
  /** The signed-in learner's username; null for a visitor or while loading. */
  username: string | null;
  notice: AuthNotice | null;
  /** Sign in. Resolves to null on success, or the failure to show. */
  signIn: (username: string, password: string) => Promise<ApiError | null>;
  /** Create an account (the learner is then signed in). Resolves like `signIn`. */
  register: (username: string, password: string) => Promise<ApiError | null>;
  /** Sign out. Resolves to false (and sets `notice`) when it failed. */
  signOut: () => Promise<boolean>;
  /** Ask `/api/auth/me` again. Resolves to false when it failed again. */
  retry: () => Promise<boolean>;
  dismissNotice: () => void;
}

export const AuthContext = createContext<AuthValue | null>(null);
