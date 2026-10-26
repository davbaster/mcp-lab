import { useContext } from "react";
import { FeedbackContext, type FeedbackValue } from "./feedbackContext";

/** Opens the feedback dialog. Only works inside `<FeedbackProvider>` (the `Layout` has one). */
export function useFeedback(): FeedbackValue {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedback must be used inside <FeedbackProvider>");
  return value;
}
