import { createContext, type RefObject } from "react";

export interface FeedbackValue {
  /**
   * Opens the dialog. `opener` gets focus back when it closes (the header button if it is gone by
   * then). `questionId` is set only by a quiz question's own button.
   */
  openFeedback: (opener: HTMLElement | null, questionId?: string) => void;
  /** The header button, where focus goes when the opener no longer exists. */
  headerButton: RefObject<HTMLButtonElement | null>;
}

export const FeedbackContext = createContext<FeedbackValue | null>(null);
