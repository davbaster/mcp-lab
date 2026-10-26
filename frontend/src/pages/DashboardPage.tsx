import { PageHeading } from "../components/PageHeading";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/** Placeholder until #18 replaces this file. */
export function DashboardPage() {
  useDocumentTitle("Course");
  return <PageHeading>Course dashboard</PageHeading>;
}
