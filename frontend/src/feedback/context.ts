/**
 * Builds the body of `POST /api/feedback`: what the learner wrote plus the page context. The
 * context is collected when "Send" is pressed and is never a form field. Nothing here reads a quiz
 * choice, an answer, a password, or a cookie.
 */
import { matchPath } from "react-router";
import type { components } from "../api/schema";
import { consoleErrors, MAX_ENTRY_LENGTH } from "./consoleBuffer";
import { cleanText, safeText } from "./safeText";

type FeedbackRequest = components["schemas"]["FeedbackRequest"];
export type FeedbackCategory = FeedbackRequest["category"];

export const MIN_MESSAGE_LENGTH = 10;
export const MAX_MESSAGE_LENGTH = 2000;

const MAX_PAGE_PATH = 2000;
const MAX_USER_AGENT = 1000;
const MAX_APP_VERSION = 100;

/** The server's rule for an ID. Anything else is sent as null, so one odd URL cannot cause a 422. */
const ID_PATTERN = /^[a-z0-9-]{1,100}$/;

/** The routes of `App.tsx` that carry IDs. Every other path (and the auth pages) has none. */
const ROUTES = [
  { pattern: "/courses/:courseId/lessons/:lessonId", ids: ["courseId", "lessonId"] },
  { pattern: "/courses/:courseId/chapters/:chapterId/quiz", ids: ["courseId", "chapterId"] },
  { pattern: "/courses/:courseId", ids: ["courseId"] },
] as const;

interface RouteIds {
  courseId: string | null;
  chapterId: string | null;
  lessonId: string | null;
}

function validId(value: string | undefined): string | null {
  return value !== undefined && ID_PATTERN.test(value) ? value : null;
}

/** The course, chapter and lesson that `pathname` is about, from the route and nothing else. */
export function routeIds(pathname: string): RouteIds {
  const none: RouteIds = { courseId: null, chapterId: null, lessonId: null };
  for (const { pattern } of ROUTES) {
    const match = matchPath({ path: pattern, end: true }, pathname);
    if (!match) continue;
    const params: Record<string, string | undefined> = match.params;
    const courseId = validId(params.courseId);
    // The other IDs need a course.
    if (courseId === null) return none;
    return {
      courseId,
      chapterId: validId(params.chapterId),
      lessonId: validId(params.lessonId),
    };
  }
  return none;
}

/** Whole pixels, at least 1 (the server's minimum), whatever the browser reports. */
function pixels(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

/** The build's version, or "dev" when the build variable is not set or empty. */
export function appVersion(): string {
  const value: unknown = import.meta.env.VITE_APP_VERSION;
  return typeof value === "string" && value.trim() !== "" ? value : "dev";
}

/** The path only, starting with one "/". */
function pagePath(pathname: string): string {
  return safeText(`/${pathname.replace(/^\/+/, "")}`, MAX_PAGE_PATH);
}

/** The message as the server will read it: cleaned, then trimmed. Validation and sending both use it. */
export function cleanMessage(message: string): string {
  return cleanText(message).trim();
}

export interface FeedbackInput {
  category: FeedbackCategory;
  message: string;
  pathname: string;
  /** The quiz question the dialog was opened from, if any. */
  questionId: string | null;
  /** The state of the "This is about the current quiz question" box. */
  aboutQuestion: boolean;
}

export function buildFeedbackRequest(input: FeedbackInput): FeedbackRequest {
  const { courseId, chapterId, lessonId } = routeIds(input.pathname);
  // Needs a course, like the other IDs.
  const questionId = courseId === null ? null : validId(input.questionId ?? undefined);
  return {
    category: input.category,
    message: cleanMessage(input.message),
    about_quiz_question: input.aboutQuestion && questionId !== null,
    context: {
      page_path: pagePath(input.pathname),
      course_id: courseId,
      chapter_id: chapterId,
      lesson_id: lessonId,
      question_id: input.aboutQuestion ? questionId : null,
      app_version: safeText(appVersion(), MAX_APP_VERSION),
      user_agent: safeText(navigator.userAgent, MAX_USER_AGENT),
      viewport: { width: pixels(window.innerWidth), height: pixels(window.innerHeight) },
      client_time: new Date().toISOString(),
      console_errors: consoleErrors().map((entry) => safeText(entry, MAX_ENTRY_LENGTH)),
    },
  };
}
